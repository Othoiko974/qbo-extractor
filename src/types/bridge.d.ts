import type { QboExtractorApi } from '../preload';

declare global {
  interface Window {
    qboApi: QboExtractorApi;
  }
}

export {};
