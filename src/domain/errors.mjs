/**
 * 领域错误：所有业务规则冲突都抛出 DomainError，
 * HTTP 层据此映射状态码与统一的错误响应格式。
 */
export class DomainError extends Error {
  constructor(code, message, httpStatus = 400, details = undefined) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = httpStatus;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function fail(code, message, httpStatus = 400, details = undefined) {
  throw new DomainError(code, message, httpStatus, details);
}
