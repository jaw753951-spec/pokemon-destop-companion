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
npm run shot         # 헤드리스로 각 화면 스크린샷 (shots/)
npm run dist         # electron-builder 패키징
```

## 창

화면 면적의 약 1/16(가로·세로 각 1/4)을 차지하는 프레임 없는 항상 위 표시 창입니다.
렌더러는 항상 480×270으로 그린 뒤 창 크기에 맞춰 정수배로 확대하므로 도트가 뭉개지지
않습니다. 창 상단에 마우스를 올리면 드래그 바가 나타나고, 위치는 자동으로 기억됩니다.

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

## 파이프라인 단계

`npm run assets` 는 아래 단계를 순서대로 실행합니다. `--only <step>` 으로 하나만,
`--sample` 로 40종만 돌려 빠르게 확인할 수 있습니다.

| 단계 | 하는 일 | 산출물 |
| --- | --- | --- |
| `dex` | 종족값·기술·아이템·타입 상성·기술머신 (한국어 명칭/설명 포함) | `data/generated/{species,moves,items,machines,types}.json` |
| `sprites` | 포켓몬 1025종의 애니 스프라이트 스트립·박스 아이콘·울음소리 | `assets/pokemon/`, `assets/cries/`, `sprites.json` |
| `items` | 아이템 아이콘, 볼 등급별 희귀도 티어 | `assets/items/`, `item-tiers.json`, `docs/item-rarity.md` |
| `actors` | 트레이너 정면/필드 도트, 나무열매 나무, 아이템 볼 | `assets/trainers/`, `assets/props/`, `actors.json` |
| `areas` | 공식 맵 30곳을 시간대 5종의 심리스 스크롤 배경으로 렌더 | `assets/areas/`, `areas.json` |
| `audio` | 에리어·전투·연출 BGM 36곡을 노트 이벤트 JSON으로 변환 | `assets/bgm/`, `bgm.json` |
| `verify` | 매니페스트와 실제 파일이 맞는지 교차 검증 | — |

전체 산출물은 약 64MB (스프라이트 36MB · 울음소리 17MB · 배경 5MB · 아이템 4.5MB ·
BGM 1.6MB · 트레이너 0.8MB) + 데이터 3.2MB 입니다.

## 파이프라인 라이브러리

`tools/lib/` 의 모듈은 외부 네이티브 의존성 없이 필요한 포맷만 직접 다룹니다.

- `png.mjs` — PNG 디코더/인코더 (1·2·4·8bpp 인덱스, 그레이, RGB, RGBA)
- `gif.mjs` — 애니메이션 GIF 디코더 (LZW, 인터레이스, disposal 처리)
- `gba-gfx.mjs` — GBA 4bpp 타일셋 · JASC 팔레트 · 메타타일 · 맵 블록데이터 렌더러
- `midi.mjs` — SMF 파서 → 절대시간 노트 이벤트
- `image.mjs` — 크롭 · 미러 · 심리스 스트립 · 시간대 컬러 그레이딩 · 프레임 리샘플
- `http.mjs` — 디스크 캐시 · 재시도 · 동시성 제한 다운로더
- `poke.mjs` — PokeAPI 레코드에서 한국어 명칭/최신 설명을 뽑는 헬퍼

## 배포 · 패키징

`npm run dist` 은 `electron-builder` 로 현재 OS용 패키지를 만듭니다. 대상은
Windows(NSIS 설치본 + zip), macOS(dmg, x64·arm64), Linux(AppImage)이며 산출물은 `dist/` 에
떨어집니다. 컨테이너에서 리눅스만 빨리 확인하려면 `npm run dist:linux` 를 쓰세요.

에셋은 저장소에 없지만 **패키지 안에는 들어갑니다.** `assets/` 와 `data/` 를
`extraResources` 로 복사하므로 설치본 하나만 받으면 추가 다운로드 없이 실행됩니다.
`src/main/paths.mjs` 가 `process.resourcesPath` 를 먼저 보고 없으면 저장소 경로로
되돌아가므로, 개발 실행과 패키지 실행이 같은 코드로 동작합니다. 세이브와 설정은 패키지
바깥의 `app.getPath('userData')` 에 저장되므로 업데이트해도 남습니다.

아이콘은 `npm run icon` 이 `build/icon.png` 를 그립니다. 저장소에 커밋되는 유일한 그림이며,
포켓몬 저작물이 아닌 자체 도형입니다.

GitHub Actions 워크플로는 세 개입니다.

| 워크플로 | 시점 | 하는 일 |
| --- | --- | --- |
| `check.yml` | 모든 푸시·PR | 에셋 빌드 → `npm run typecheck` → `npm test` |
| `build.yml` | `v*` 태그 푸시 (또는 수동) | 3개 OS 매트릭스로 패키징 → **드래프트 릴리스**에 업로드 |
| `itch.yml` | `build.yml` 성공 후 | `ITCH_API_KEY`·`ITCH_TARGET` 이 설정된 경우에만 `butler push` |

에셋 다운로드는 `tools/**` 와 `package-lock.json` 해시를 키로 `actions/cache` 에 캐시되므로,
게임 코드만 바꾼 빌드는 내려받기를 건너뜁니다. 서명 인증서가 없어 macOS 빌드는 서명되지
않은 상태로 나갑니다(첫 실행 시 Gatekeeper 우회 필요).

릴리스 절차:

```bash
npm version 0.1.1        # package.json 버전 갱신 + 태그
git push --follow-tags   # build.yml 이 태그를 받아 드래프트 릴리스 생성
```

## 에리어

수록 에리어는 전부 3세대 호연 지방의 실제 맵입니다. 한 지방으로 통일한 이유는 화풍이
일관되기도 하지만, PokeAPI가 **호연 지역명의 한국어 정식 명칭을 가지고 있기 때문**입니다
(관동 지역명에는 한국어가 없습니다). 각 맵에서 통행 가능한 블록이 가장 많은 가로 띠를 골라
잘라낸 뒤, 좌우 반전본을 이어붙여 이음매 없이 순환하는 스크롤 배경으로 만듭니다.
