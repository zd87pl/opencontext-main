export interface MeteringRecord {
  passportId: string;
  partnerId: string;
  timestamp: number;
  bytes: number;
  requests: number;
  cost: string; // Wei amount
}

export interface PartnerConfig {
  id: string;
  name: string;
  baseUrl: string;
  costPerByte: string; // Wei per byte
  costPerRequest: string; // Wei per request
  authRequired: boolean;
  rateLimits?: {
    requests: number;
    window: number; // seconds
  };
}

export interface StreamingSession {
  passportId: string;
  partnerId: string;
  flowRate: string; // Wei per second
  startTime: number;
  active: boolean;
}