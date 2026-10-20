import { Request } from 'express';
import { AppError } from '../common/middleware/error-handler.js';

/**
 * Returns the authenticated user or throws a 401. Use in routes that sit behind
 * `requireAuth`/`authenticateToken` so handlers do not have to re-check `req.user`.
 */
export function requireUser(req: Request): Express.User {
  if (!req.user) {
    throw new AppError(401, 'Authentication required');
  }
  return req.user;
}
