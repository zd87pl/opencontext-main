import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../logger.js';

/**
 * An error with an HTTP status attached. Throw (or `next()`) one of these from a
 * route when the failure is expected and should be reported to the client as-is.
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public isOperational = true
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * Final error middleware. Express recognises error handlers by their arity, so
 * the unused `_next` parameter has to stay.
 */
export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
  if (err instanceof AppError) {
    logger.error({
      message: err.message,
      statusCode: err.statusCode,
      path: req.path,
      method: req.method
    });

    res.status(err.statusCode).json({
      error: { message: err.message, statusCode: err.statusCode }
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: { message: 'Invalid request', statusCode: 400, issues: err.issues }
    });
    return;
  }

  const error = err instanceof Error ? err : new Error(String(err));
  logger.error({
    message: error.message,
    stack: error.stack,
    path: req.path,
    method: req.method
  });

  res.status(500).json({
    error: { message: 'Internal server error', statusCode: 500 }
  });
};
