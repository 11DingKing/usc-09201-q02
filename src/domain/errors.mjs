/**
 * 所有业务规则失败都使用 DomainError，code 稳定可被测试与客户端依赖，
 * status 对应 HTTP 状态码，details 承载确定的判定依据。
 */
export class DomainError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function fail(code, message, options) {
  throw new DomainError(code, message, options);
}
