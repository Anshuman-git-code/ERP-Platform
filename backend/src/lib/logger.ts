import winston from 'winston';

const { combine, timestamp, json, colorize, simple } = winston.format;

const isProduction = process.env.NODE_ENV === 'production';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
  format: isProduction
    ? combine(timestamp(), json())
    : combine(colorize(), timestamp({ format: 'HH:mm:ss' }), simple()),
  transports: [new winston.transports.Console()],
});
