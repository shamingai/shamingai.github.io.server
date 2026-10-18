export class ApiError extends Error {
  constructor(statusCode, code, message, extra) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra;
  }
}

export function notFound(code, message) {
  return new ApiError(404, code, message);
}

export function badRequest(code, message) {
  return new ApiError(400, code, message);
}

export function conflict(code, message, extra) {
  return new ApiError(409, code, message, extra);
}
