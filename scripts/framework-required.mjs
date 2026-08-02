const action = process.argv[2] ?? "실행";
console.error(
  `${action}은 프레임워크를 추측하지 않습니다. pnpm ${action}:tauri 또는 pnpm ${action}:electron을 사용하십시오.`,
);
process.exit(1);
