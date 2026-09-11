/** 极简断言harness：不引第三方依赖，输出对齐的检查清单。 */

let passed = 0;
const failures: string[] = [];

export function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  \u001b[32m✓\u001b[0m ${name}${detail ? `  \u001b[2m${detail}\u001b[0m` : ''}`);
  } else {
    failures.push(name);
    console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? `  \u001b[2m${detail}\u001b[0m` : ''}`);
  }
}

export function near(name: string, actual: number, expected: number, tol: number): void {
  const diff = Math.abs(actual - expected);
  check(name, diff <= tol, `|${actual.toFixed(6)} - ${expected.toFixed(6)}| = ${diff.toExponential(2)} ≤ ${tol}`);
}

export function section(title: string): void {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

export function summary(): void {
  console.log('');
  if (failures.length === 0) {
    console.log(`\u001b[32m全部通过\u001b[0m：${passed} 项检查`);
  } else {
    console.log(`\u001b[31m失败 ${failures.length} 项\u001b[0m / 共 ${passed + failures.length} 项`);
    for (const f of failures) console.log(`   - ${f}`);
    process.exitCode = 1;
  }
}
