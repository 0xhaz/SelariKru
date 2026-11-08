import type { DeviceAvailability } from './sdk.ts';
import { CLOUD_MODEL, SDK_VERSION } from './models.ts';

export type DeviceReadiness = DeviceAvailability | 'evicted';

export interface Readiness {
  readonly device: DeviceReadiness;
  readonly cloudModel: string;
  readonly sdkVersion: string;
}

/**
 * Tracks device model readiness. 'evicted' means the model was seen available earlier in
 * this session and the browser now reports it downloadable again.
 */
export class ReadinessTracker {
  private seenAvailable = false;
  private downloading = false;

  setDownloading(v: boolean): void {
    this.downloading = v;
  }

  observe(raw: DeviceAvailability): DeviceReadiness {
    if (this.downloading) return 'downloading';
    if (raw === 'available') {
      this.seenAvailable = true;
      return raw;
    }
    if (raw === 'downloadable' && this.seenAvailable) return 'evicted';
    return raw;
  }

  snapshot(device: DeviceReadiness): Readiness {
    return { device, cloudModel: CLOUD_MODEL, sdkVersion: SDK_VERSION };
  }
}
