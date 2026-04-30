import React from 'react';
import { Sidebar } from './Sidebar';
import { Dashboard } from './screens/Dashboard';
import { Extraction } from './screens/Extraction';
import { Onboarding } from './screens/Onboarding';
import { Connect } from './screens/Connect';
import { GSheets } from './screens/GSheets';
import { Review } from './screens/Review';
import { History } from './screens/History';
import { Settings } from './screens/Settings';
import { Vendors } from './screens/Vendors';
import { Preview } from './screens/Preview';
import { AmbiguousResolver } from './screens/AmbiguousResolver';
import { Placeholder } from './screens/Placeholder';
import { VendorClusterModal } from './VendorClusterModal';
import { ShortcutOverlay } from './ShortcutOverlay';
import { BusyLockModal } from './BusyLockModal';
import { useStore } from '../store/store';

export function App() {
  const { screen, setScreen } = useStore();

  let content: React.ReactNode;
  switch (screen) {
    case 'onboarding':
      content = <Onboarding onStart={() => setScreen('connect')} />;
      break;
    case 'dashboard':
      content = <Dashboard />;
      break;
    case 'extraction':
      content = <Extraction onOpenReview={() => setScreen('review')} />;
      break;
    case 'review':
      content = <Review />;
      break;
    case 'vendors':
      content = <Vendors />;
      break;
    case 'history':
      content = <History />;
      break;
    case 'settings':
      content = <Settings />;
      break;
    case 'connect':
      content = <Connect />;
      break;
    case 'gsheets':
      content = <GSheets />;
      break;
    case 'preview':
      content = <Preview />;
      break;
    case 'resolver':
      content = <AmbiguousResolver />;
      break;
    default:
      content = <Placeholder title={screen} />;
  }

  const fullBleed = screen === 'onboarding';

  return (
    <div className="app-shell">
      {!fullBleed && <Sidebar />}
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {content}
      </main>
      <VendorClusterModal />
      <BusyLockModal />
      <ShortcutOverlay />
    </div>
  );
}
