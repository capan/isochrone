import MapView from './MapView';
import 'leaflet/dist/leaflet.css';

// MapView owns the full-height flex shell now; a wrapper with its own 100vh
// fought the dynamic viewport unit the bottom sheet relies on.
function App() {
  return <MapView />;
}

export default App;
