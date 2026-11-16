/**
 * CloudWatch Embedded Metric Format（契約第 9 節）。
 * 寫一行 JSON 到 stdout，由 EC2 上的 CloudWatch agent 收進 log group 後轉成指標。
 */
import { METRIC_NAMESPACE, type MetricName, type ScanTarget, type ScanTier } from '../../../shared/contracts.ts';

const UNITS: Record<MetricName, string> = {
  ScanDurationMs: 'Milliseconds',
  ScanErrors: 'Count',
  ReleasedEvents: 'Count',
};

export function emfLine(
  dims: { Tier: ScanTier; Target: ScanTarget },
  values: Partial<Record<MetricName, number>>,
  props: Record<string, unknown> = {},
  now = Date.now(),
): string {
  const names = (Object.keys(values) as MetricName[]).filter((k) => values[k] !== undefined);
  return JSON.stringify({
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [['Tier', 'Target']],
          Metrics: names.map((n) => ({ Name: n, Unit: UNITS[n] })),
        },
      ],
    },
    ...props,
    ...dims,
    ...values,
  });
}

export type MetricsSink = (line: string) => void;
export const stdoutSink: MetricsSink = (line) => process.stdout.write(line + '\n');
