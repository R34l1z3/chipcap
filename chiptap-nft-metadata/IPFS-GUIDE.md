# ChipTap NFT — IPFS Upload Guide

## Шаг 1: Сгенерируй файлы

```powershell
cd chiptap-nft-metadata
npm run generate:samples     # 25 тестовых (5 на каждый рарити)
# или
npm run generate:batch       # 100 штук
```

Файлы появятся в `output/images/` (SVG) и `output/metadata/` (JSON).

---

## Шаг 2: Выбери IPFS-сервис

### Вариант A: Pinata (рекомендую для начала)
1. Зарегистрируйся: https://www.pinata.cloud/
2. Бесплатный план: 500 файлов, 100 MB
3. Получи API Key в Settings → API Keys

### Вариант B: NFT.storage (бесплатно, backed by Filecoin)
1. Зарегистрируйся: https://nft.storage/
2. Безлимитное хранилище для NFT

### Вариант C: Arweave (перманентное хранилище)
1. Нужно заплатить один раз за навсегда
2. Через https://ardrive.io/ или https://akord.com/

---

## Шаг 3: Загрузи изображения

### Через Pinata Web UI:
1. Открой https://app.pinata.cloud/
2. Upload → Folder → выбери `output/images/`
3. Назови папку `chiptap-images`
4. После загрузки получишь CID, например: `QmXyz123...`
5. Изображения доступны по: `ipfs://QmXyz123.../chip_1.svg`

### Через Pinata CLI:
```bash
npx pinata-cli upload ./output/images --name chiptap-images
```

---

## Шаг 4: Обнови metadata с реальным CID

```powershell
node scripts/generateMetadata.js ipfs://QmXyz123.../
```

Это перезапишет все JSON в `output/metadata/` с правильными ссылками на изображения.

---

## Шаг 5: Загрузи metadata

Повтори шаг 3 для папки `output/metadata/`.
Получишь второй CID, например: `QmAbc456...`

Metadata доступна по: `ipfs://QmAbc456.../1.json`

---

## Шаг 6: Обнови контракт

На ChipNFT → Write Contract → `setBaseURI`:

```
_baseURI: ipfs://QmAbc456.../
```

Теперь `tokenURI(1)` вернёт `ipfs://QmAbc456.../1.json`

Маркетплейсы (OpenSea, Rarible) подхватят metadata автоматически.

---

## Проверка

После обновления baseURI:

1. Открой https://testnets.opensea.io/ (для Amoy)
2. Вставь адрес ChipNFT контракта
3. Должны появиться чипы с изображениями и атрибутами

Или вручную:
```
https://ipfs.io/ipfs/QmAbc456.../1.json
```

---

## Структура metadata (ERC-721 + OpenSea)

```json
{
  "name": "ChipTap #1",
  "description": "A standard ChipTap battle chip...",
  "image": "ipfs://QmXyz123.../chip_1.svg",
  "external_url": "https://chiptap.gg/chip/1",
  "attributes": [
    { "trait_type": "Rarity", "value": "Common" },
    { "trait_type": "Max Supply", "value": "Unlimited" },
    { "display_type": "number", "trait_type": "Rarity Tier", "value": 0, "max_value": 4 },
    { "trait_type": "Collection", "value": "Genesis" },
    { "trait_type": "Game", "value": "ChipTap PvP" }
  ]
}
```
