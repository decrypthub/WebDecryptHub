// Child tools receive only OS runtime variables, never model/provider credentials.
export function childEnv(base = {}, additions = {}) {
  const allow =
    /^(?:PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|SYSTEMDRIVE|PROGRAMFILES(?:\(X86\))?|COMMONPROGRAMFILES(?:\(X86\))?|LANG|LC_[A-Z_]+|TERM|COLORTERM|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS)$/i;
  return {
    ...Object.fromEntries(Object.entries(base).filter(([k, v]) => v != null && allow.test(k))),
    ...additions,
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
}
