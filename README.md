# 포켓몬 데스크탑 컴패니언 (Pokémon Desktop Companion)

화면 위에 항상 떠 있는 작은 창 안에서 포켓몬이 혼자 여행하고, 싸우고, 파밍하며 자라는
데스크탑 다마고치입니다. 플레이어는 언제든 돌아와서 성장 상황을 확인하고, 아이템과 기술을
정비하고, 체육관 관장·사천왕·챔피언에게 도전할 수 있습니다.

**비상업 팬 프로젝트입니다.** Pokémon 및 관련 명칭·이미지·음악의 모든 권리는 Nintendo /
Creatures Inc. / GAME FREAK inc. 에 있습니다. 이 저장소는 저작물을 포함하지 않습니다 —
아래 "에셋" 항목을 참고하세요.

---

## 개발 준비

```bash
npm install          # 의존성
npm run assets       # 에셋·데이터 내려받기 및 빌드 (최초 1회, 약 10분)
npm start            # 앱 실행
```

검사용 명령:

```bash
npm run typecheck    # tsc --checkJs --noEmit
npm test             # node:test 단위 테스트
npm run dist         # electron-builder 패키징
```

## 에셋

게임에 쓰이는 스프라이트·타일셋·울음소리·BGM은 **저장소에 포함되지 않습니다.**
`npm run assets` 가 공개된 데이터 소스에서 내려받아 `assets/` 와 `data/generated/` 에
빌드하며, 두 디렉터리 모두 `.gitignore` 대상입니다.

| 내용 | 출처 |
| --- | --- |
| 룰 데이터 · 한국어 명칭/설명 | [`PokeAPI/api-data`](https://github.com/PokeAPI/api-data) |
| 포켓몬 스프라이트 (BW·Showdown 애니메이션 포함) | [`PokeAPI/sprites`](https://github.com/PokeAPI/sprites) |
| 포켓몬 울음소리 | [`PokeAPI/cries`](https://github.com/PokeAPI/cries) |
| 타일셋 · 맵 · 트레이너 도트 · 아이템 아이콘 · BGM | [`pret/pokeemerald`](https://github.com/pret/pokeemerald), [`pret/pokefirered`](https://github.com/pret/pokefirered) |

## 구조

```
tools/    에셋·데이터 파이프라인 (Node)
  lib/    png · gif · midi · gba-gfx · image · http
  fetch/  원본 내려받기
  build/  게임에서 쓸 형태로 가공
src/
  main/     Electron 메인 프로세스 (창, 세이브, 설정)
  preload/  렌더러 ↔ 메인 브리지
  renderer/ 게임 본체 (core · engine · render · scenes · ui)
data/
  authored/  손으로 저술한 데이터 (관장/사천왕/챔피언, i18n)
  generated/ 파이프라인 산출물 (gitignored)
test/     단위 테스트
```

## 파이프라인 라이브러리

`tools/lib/` 의 모듈은 외부 네이티브 의존성 없이 필요한 포맷만 직접 다룹니다.

- `png.mjs` — PNG 디코더/인코더 (1·2·4·8bpp 인덱스, 그레이, RGB, RGBA)
- `gif.mjs` — 애니메이션 GIF 디코더 (LZW, 인터레이스, disposal 처리)
- `gba-gfx.mjs` — GBA 4bpp 타일셋 · JASC 팔레트 · 메타타일 · 맵 블록데이터 렌더러
- `midi.mjs` — SMF 파서 → 절대시간 노트 이벤트
- `image.mjs` — 크롭 · 미러 · 심리스 스트립 · 시간대 컬러 그레이딩 · 프레임 리샘플
- `http.mjs` — 디스크 캐시 · 재시도 · 동시성 제한 다운로더
