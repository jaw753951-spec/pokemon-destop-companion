# 직접 그린 포켓몬 도트

이 폴더의 도트는 에셋 빌드(`npm run assets -- --only art`)가 가장 마지막에 덮어써서,
PokeAPI의 블랙·화이트 폴더에서 받은 그림보다 항상 우선합니다.

## 폴더 하나 = 그림 한 장

폴더 이름이 무엇을 그린 것인지 정합니다. 이로치는 이름 끝에 `-shiny` 를 붙입니다.

| 그린 것 | 폴더 이름 예 |
| --- | --- |
| 종·변종 | `urshifu-rapid-strike`, `oinkologne-female`, `diglett-shiny`, `dugtrio-alola-shiny` |
| 폼 | `cramorant-gulping`, `darmanitan-galar-zen`, `ogerpon-hearthflame-mask-shiny` |
| 종의 암컷 모습 | `jellicent-female`, `pikachu-female-shiny` |

이름은 `data/generated/species.json` 의 `slug`(폼은 `forms[].slug`)와 같아야 합니다.
빌드 로그의 `drawn for this game:` 줄에 쓰인 폴더가, `not used from data/authored/sprites:` 줄에
이름을 못 알아본 폴더가 나옵니다.

## 그림 형식 (블랙·화이트 전투 도트와 같음)

각 폴더에 `front.png` 한 장:

- 블랙·화이트의 앞모습 전투 도트처럼 **왼쪽을 보는** 그림. 캔버스는 96×96 안쪽이면 되고, 빌드가
  투명한 여백을 잘라 냅니다.
- 도트 한 칸 = 전투 화면 2픽셀. 크기는 같은 종의 BW 도트
  (`data/vendor/pokeapi/sprites/pokemon/versions/generation-v/black-white/<번호>.png`)에 맞추면 됩니다.
  그 파일을 복사해 그 위에 그리는 것이 가장 쉽습니다.

빌드가 이 한 장을 모든 화면에 씁니다 — 필드와 포켓몬 탭은 같은 그림을 절반 크기(도트 한 칸 = 화면 1픽셀)로 그립니다.
움직임은 게임이 그림째 움직여서 내므로 프레임은 필요 없습니다.
