import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';

/**
 * Reads express-validator results and returns 422 if there are errors.
 * Place this after the validation chain in route definitions.
 */
export function validate(req: Request, res: Response, next: NextFunction) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array(),
    });
  }
  return next();
}
