import { Request, Response, NextFunction } from 'express';
import { logger } from './logger';
import { pipelineStageLatencyMs } from './metrics';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();

  logger.info(`${req.method} ${req.path}`, {
    requestId: (req as any).requestId,
    traceId: (req as any).traceId,
    spanId: (req as any).spanId,
    query: req.query,
    ip: req.ip,
  });

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const status = res.statusCode >= 500 ? 'error' : 'ok';
    pipelineStageLatencyMs.observe({ stage: 'api_serve', status }, durationMs);
  });

  next();
}
