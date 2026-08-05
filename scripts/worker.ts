import pino from "pino";
import async from "async";

let jobSuccessCount = 0;
let jobFailureCount = 0;
let startTime = Date.now();
import amqp from "amqplib";

const logger = pino({
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    },
  },
});

const QUEUE_NAME = "isochrone_jobs";

// Routing SQL, cost profiles and cache keys all live in the backend — the
// worker just drives it, so the two can never disagree about what's cached.
const API = process.env.API ?? "http://localhost:3001";
const PROFILE = process.env.PROFILE ?? "walk";

async function computeIsochrones(
  lat: number,
  lon: number,
  durations: number[]
) {
  const jobStart = Date.now();
  const minutes = Math.max(...durations);

  logger.info({ lat, lon, minutes }, "🚀 Received computation request");

  try {
    const res = await fetch(
      `${API}/api/isochrone?lat=${lat}&lon=${lon}&minutes=${minutes}&profile=${PROFILE}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${API}`);
    const data = await res.json();

    logger.info(
      { lat, lon, minutes, bands: data.geojson.features.length, time: `${Date.now() - jobStart}ms` },
      "✅ Isochrone warmed"
    );
  } catch (err) {
    logger.error(
      {
        lat,
        lon,
        minutes,
        error: err instanceof Error ? err.stack || err.message : String(err),
      },
      "💥 Error during isochrone computation"
    );
    throw err;
  }
}

(async () => {
  const conn = await amqp.connect("amqp://localhost");
  const ch = await conn.createChannel();
  await ch.assertQueue(QUEUE_NAME, { durable: true });
  const DLQ_NAME = "isochrone_dlq";
  await ch.assertQueue(DLQ_NAME, { durable: true });

  logger.info(`🚀 Waiting for jobs in ${QUEUE_NAME}...`);

  const queue = async.queue(async (job, cb) => {
    try {
      logger.info(
        {
          lat: job.lat.toFixed(5),
          lon: job.lon.toFixed(5),
          durations: job.durations,
        },
        "🚀 Starting full job"
      );
      await computeIsochrones(job.lat, job.lon, job.durations);
      jobSuccessCount++;
    } catch (err) {
      throw err;
    }
    cb();
  }, 1); // concurrency = 2

  // Batched fetch and processing logic
  async function processBatches(batchSize: number) {
    while (true) {
      const messages = [];
      for (let i = 0; i < batchSize; i++) {
        const msg = await ch.get(QUEUE_NAME, { noAck: false });
        if (msg) messages.push(msg);
        else break;
      }

      if (messages.length === 0) {
        logger.info("✅ No more messages in queue. Sleeping for 5 seconds...");
        await new Promise((res) => setTimeout(res, 5000));
        continue;
      }

      logger.info({ batchSize: messages.length }, "📦 Processing new batch");

      await new Promise<void>((resolveBatch) => {
        let pending = messages.length;
        messages.forEach((msg) => {
          const job = JSON.parse(msg.content.toString());

          queue.push(job, async (err) => {
            if (err) {
              let attempt = job.attempt || 1;
              if (attempt < 4) {
                const delay = attempt * 60 * 1000;
                logger.warn(
                  { attempt, lat: job.lat, lon: job.lon, delay },
                  "🔁 Retrying job"
                );
                setTimeout(() => {
                  ch.sendToQueue(
                    QUEUE_NAME,
                    Buffer.from(
                      JSON.stringify({ ...job, attempt: attempt + 1 })
                    ),
                    { persistent: true }
                  );
                }, delay);
              } else {
                logger.error(
                  { lat: job.lat, lon: job.lon },
                  "☠️ Moved to DLQ after 3 failed attempts"
                );
                ch.sendToQueue(DLQ_NAME, Buffer.from(JSON.stringify(job)), {
                  persistent: true,
                });
                jobFailureCount++;
              }
            } else {
              jobSuccessCount++;
            }

            ch.ack(msg);
            pending--;
            if (pending === 0) {
              const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
              logger.info(
                {
                  summary: {
                    successfulJobs: jobSuccessCount,
                    failedJobs: jobFailureCount,
                    queueLength: queue.length(),
                    totalElapsedSeconds: elapsed,
                  },
                },
                "📊 Batch processing summary"
              );
              resolveBatch();
            }
          });
        });
      });
    }
  }

  // Start processing batches of 1000
  processBatches(2);
// Graceful shutdown handling — nothing to drain now that the backend owns
// the db and cache connections.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    logger.info(`🛑 Caught ${sig}. Gracefully shutting down...`);
    process.exit(0);
  });
}
})();
