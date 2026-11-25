import { ImportPanel } from './features/ImportPanel';
import { LabelScanCard } from './features/LabelScanCard';
import { LocateCard } from './features/LocateCard';
import { MapCard } from './features/map/MapCard';
import { StopReviewList } from './features/StopReviewList';
import { useHealthQuery } from './store/api';

export default function App() {
  const { data, isError } = useHealthQuery();
  const servicesUp = data && Object.values(data.services).every((s) => s === 'up');

  return (
    <main className="app">
      <header className="top">
        <h1>Easy Ground</h1>
        <span
          className={`dot ${servicesUp ? 'good' : 'bad'}`}
          title={isError ? 'API offline' : data ? JSON.stringify(data.services) : 'Connecting…'}
        />
      </header>
      <ImportPanel />
      <LocateCard />
      <MapCard />
      <LabelScanCard />
      <StopReviewList />
    </main>
  );
}
