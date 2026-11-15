export type AnalyticsRange = '7d' | '30d' | '90d' | 'all' | string;

export interface AnalyticsAuthContext {
  userId: string;
  tenantId: string;
  email: string;
}
