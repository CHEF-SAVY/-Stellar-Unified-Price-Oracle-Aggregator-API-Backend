import { Request, Response, NextFunction } from 'express';
import { logger } from './logger';

export function requestLogger(req: Request, _res: Response, next: NextFunction): void {
  logger.info(`${req.method} ${req.path}`, {
    requestId: req.requestId,
    traceId: req.traceId,
    spanId: req.spanId,
    query: req.query,
    ip: req.ip,
  });
  next();
}
