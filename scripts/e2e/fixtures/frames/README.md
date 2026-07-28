# 픽셀 오라클 픽스처

판정기가 무엇을 백지로 보는지는 실물 바이트로만 증명된다. 출처는 `frames.json` 이 값으로
들고 있다(원본 경로·크기·mtime·sha256, 합성이면 어떻게 만들었는지).

| 파일 | 출처 | 무엇 |
|---|---|---|
| `blank-window.png` | 합성 | 창 전체 단색 — 아무것도 안 그려진 프레임 |
| `blank-retina.png` | 합성 | 레티나 창 전체 단색. **크기는 실렌더 슬롯보다 크다**(크기 휴리스틱 반례) |
| `blank-gradient.png` | 합성 | 세로 그라디언트. 고유색 67·엔트로피 0.93 — 색 수로도 엔트로피로도 안 잡힌다 |
| `rendered-window.png` | 실물 캡처 파생 | 창 전체 캡처를 1/4 로 축소. 정상 렌더 |
| `rendered-slot.png` | 실물 캡처 파생 | 원본 해상도 320x200 크롭. 뷰 슬롯 하나 크기의 정상 렌더 |
| `hole-window.png` | 실물 캡처 + 합성 구멍 | `rendered-window` 의 콘텐츠 영역을 앱 배경색으로 덮은 것 — 네이티브 자식이 캡처에 안 찍힌 프레임의 모양 |

재생성(멱등, 난수 없음):

```bash
node scripts/e2e/make-frame-fixtures.mjs --source <실물캡처.png>   # 전부
node scripts/e2e/make-frame-fixtures.mjs                          # 합성분만(실물 파생분 유지)
```

실물 파생 픽스처가 없는데 `--source` 도 없으면 만들지 않고 실패한다 — 조용히 빼먹지 않는다.
