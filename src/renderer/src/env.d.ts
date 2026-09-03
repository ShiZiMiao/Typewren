/// <reference types="vite/client" />

import type { TypewrenApi } from '../../shared/typewren-api';

export type { TypewrenApi };

declare global {
  interface Window {
    typewren: TypewrenApi;
  }
}
