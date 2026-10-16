'use strict';

class ApiError extends Error {
  constructor(status, message, code = 'error', fields = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

const badRequest = (msg, fields) => new ApiError(400, msg, 'validation_error', fields);
const unauthorized = (msg = 'Authentication required') => new ApiError(401, msg, 'unauthorized');
const forbidden = (msg = 'You do not have permission to perform this action') => new ApiError(403, msg, 'forbidden');
const notFound = (msg = 'Resource not found') => new ApiError(404, msg, 'not_found');
const conflict = (msg) => new ApiError(409, msg, 'conflict');

/** Wrap async route handlers so rejections reach the error middleware. */
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { ApiError, badRequest, unauthorized, forbidden, notFound, conflict, asyncH };
