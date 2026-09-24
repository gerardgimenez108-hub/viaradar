export interface Row {
  [key: string]: string;
}
export interface TripDescriptor {
  tripId?: string;
  startDate?: string;
  startTime?: string;
  scheduleRelationship?: string | number;
}
export interface StopTimeEvent {
  time?: number | string;
  delay?: number;
}
export interface StopUpdate {
  stopId?: string;
  stopSequence?: number;
  scheduleRelationship?: string | number;
  departure?: StopTimeEvent;
  arrival?: StopTimeEvent;
}
export interface VehicleDescriptor {
  id?: string;
  label?: string;
}
export interface Vehicle {
  trip?: TripDescriptor;
  vehicle?: VehicleDescriptor;
  timestamp?: number | string;
  stopId?: string;
  currentStatus?: string | number;
}
export interface TripUpdate {
  trip?: TripDescriptor;
  timestamp?: number | string;
  stopTimeUpdate?: StopUpdate[];
  delay?: number;
}
export interface FeedHeader {
  timestamp?: number | string;
}
export interface FeedEntity {
  id?: string;
  vehicle?: Vehicle;
  tripUpdate?: TripUpdate;
}
export interface Feed {
  header: FeedHeader;
  entity: FeedEntity[];
}
export const PLATFORM = {
  OFFICIAL: "official",
  PREDICTION: "prediction",
  UNKNOWN: "unknown",
} as const;
export type PlatformKind = (typeof PLATFORM)[keyof typeof PLATFORM];
export const EVIDENCE = { OFFICIAL: "official_vehicle", HISTORICAL: "historical_share", INSUFFICIENT: "insufficient_history", VARIABLE: "variable_history", CANCELLED: "cancelled" } as const;
export type EvidenceCode = typeof EVIDENCE[keyof typeof EVIDENCE];
export interface EvidenceContext { stationId?: string; observedAt?: string; }
export interface Platform {
  evidenceCode?: EvidenceCode;
  evidenceContext?: EvidenceContext;
  expiresAt?: string;
  kind: PlatformKind;
  value: string | null;
  confidence: number | null;
  sampleCount: number;
  evidence: string;
}
export interface Departure {
  destinationUnavailable?: boolean;
  tripId: string;
  serviceDate: string;
  line: string;
  destination: string;
  scheduledAt: string;
  expectedAt: string;
  cancelled: boolean;
  realtime: boolean;
  platform: Platform;
}
export interface SourceStatus {
  kind: string;
  url: string;
  fetchedAt: string | null;
  feedTimestamp: string | null;
  ageSeconds: number | null;
  healthy: boolean;
  error: string | null;
}
export interface Station {
  id: string;
  name: string;
}
export interface Board {
  station: Station;
  generatedAt: string;
  staticImportedAt: string | null;
  sources: SourceStatus[];
  incidents: IncidentBoard;
  departures: Departure[];
  warnings: string[];
}

export interface IncidentTranslation { language?: string; text: string; }
export interface Incident {
  id: string;
  translations: IncidentTranslation[];
  stopIds: string[];
  lines: string[];
  activePeriods: { start: string | null; end: string | null }[];
}
export interface IncidentBoard {
  status: "healthy" | "stale" | "unavailable";
  fetchedAt: string | null;
  feedTimestamp: string | null;
  error: string | null;
  items: Incident[];
}
