# 직접 그린 포켓몬 도트

이 폴더의 도트는 에셋 빌드(`npm run assets -- --only walkers`)가 가장 마지막에 덮어써서,
Sprite Collab이나 Essentials에서 받은 그림보다 항상 우선합니다.

## 폴더 하나 = 시트 한 벌

폴더 이름이 무엇을 그린 것인지 정합니다. 이로치는 이름 끝에 `-shiny` 를 붙입니다.

| 그린 것 | 폴더 이름 예 |
| --- | --- |
| 종·변종 | `urshifu-rapid-strike`, `oinkologne-female`, `diglett-shiny`, `dugtrio-alola-shiny` |
| 폼 | `cramorant-gulping`, `darmanitan-galar-zen`, `ogerpon-hearthflame-mask-shiny` |
| 종의 암컷 모습 | `jellicent-female`, `pikachu-female-shiny` |

이름은 `data/generated/species.json` 의 `slug`(폼은 `forms[].slug`)와 같아야 합니다.
빌드 로그의 `drawn for this game:` 줄에 쓰인 폴더가, `not used from data/authored/sprites:` 줄에
이름을 못 알아본 폴더가 나옵니다.

## 시트 형식 (Sprite Collab과 같음)

각 폴더에 세 파일:

- `AnimData.xml` — 애니메이션마다 프레임 크기(`FrameWidth`/`FrameHeight`)와 프레임 길이
  (`Duration`, 60분의 1초 단위). `Walk` 와 `Idle` 이 있어야 합니다. `Idle` 을 `<CopyOf>Walk</CopyOf>` 로
  두면 걷기 그림으로 서 있습니다.
- `Walk-Anim.png` — 걷기. 가로로 프레임, 세로로 방향 8줄.
- `Idle-Anim.png` — 서 있기. 같은 배치.

방향 8줄은 위에서부터 아래·오른쪽아래·**오른쪽**·오른쪽위·위·왼쪽위·왼쪽·왼쪽아래이고,
**이 게임은 세 번째 줄(오른쪽을 보는 줄)만 씁니다.** 나머지 줄은 바탕 시트 그대로 두어도 됩니다.
프레임 수를 바꾸면 `AnimData.xml` 의 `Duration` 줄 수도 맞춰 주세요.

도트 한 칸 = 화면 한 픽셀(필드에서는 2×2)이라 크기 조절 없이 그린 그대로 나옵니다. 크기는 같은 종의
Collab 도트에 맞추면 됩니다. 프레임 가운데에 발을 두면 걷다 멈출 때 옆으로 미끄러지지 않습니다.
