// producer.ts - pushes jobs to RabbitMQ
import amqp from 'amqplib';

const QUEUE_NAME = 'isochrone_jobs';

const durations = (process.env.DURATIONS ?? '5,10,15')
  .split(',')
  .map(d => parseInt(d.trim(), 10));

const minLat = parseFloat(process.env.MINLAT ?? '52.47');
const maxLat = parseFloat(process.env.MAXLAT ?? '52.57');
const minLon = parseFloat(process.env.MINLON ?? '13.35');
const maxLon = parseFloat(process.env.MAXLON ?? '13.50');
const step = parseFloat(process.env.STEP ?? '0.0001');

(async () => {
  const conn = await amqp.connect('amqp://localhost');
  const ch = await conn.createChannel();
  await ch.assertQueue(QUEUE_NAME, { durable: true });

  const jobs = [];
  for (let lat = minLat; lat <= maxLat; lat += step) {
    for (let lon = minLon; lon <= maxLon; lon += step) {
      jobs.push({
        lat: parseFloat(lat.toFixed(5)),
        lon: parseFloat(lon.toFixed(5)),
        durations,
      });
    }
  }

  for (const job of jobs) {
    ch.sendToQueue(QUEUE_NAME, Buffer.from(JSON.stringify(job)), {
      persistent: true,
    });
    console.log(`📤 Queued job for (${job.lat}, ${job.lon})`);
  }

  await ch.close();
  await conn.close();
  console.log('✅ All jobs queued.');
})();
