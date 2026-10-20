# IluCanvas

**Бесконечная доска для референсов. Каждая доска — один файл `.ilucanvas` на вашем диске.**
*An infinite reference board. Every board is one `.ilucanvas` file on your disk.*

Как PureRef и FigJam, только без сервера и аккаунтов: страница в браузере,
файлы — у вас. Внутри `.ilucanvas` — обычный ZIP: `canvas.json` (где что лежит)
и папка `images/` с оригиналами картинок под их собственными именами.
Переименуйте копию в `.zip` — и достаньте любой реф.

**Доска:** https://ilumetric.github.io/IluCanvas/ · **Демо:** https://ilumetric.github.io/IluCanvas/?demo

- **Быстро на больших досках.** Рисуется только видимое, каждая картинка — в
  том размере, в каком она на экране: из файла читаются превью ≤ 512 px, а
  оригиналы — только когда картинку приблизили. Доска на 10 000 картинок,
  показанная целиком, рисуется за ~9 мс. Открытие не зависит от размера файла.
- **Рефы не теряются.** Сохранение дописывает только изменения (новые картинки
  и `canvas.json`) и заменяет файл атомарно; автосохранение включено. Если
  запись оборвалась — файл восстанавливается по записям внутри ZIP.
- **Панель досок слева:** *Открыть папку* — все `.ilucanvas` и `.pur` из неё с
  обложками; недавние файлы; доски по ссылке.
- **Инструменты:** выделение (V) и рука (H); группы-рамки с названием и цветом
  (Ctrl+G, вложенные), «Упорядочить» (Shift+A), отражение, поворот, исходный
  размер, порядок слоёв; миникарта; перетаскивание и вставка картинок (Ctrl+V),
  папок, картинок из других сайтов.
- **Три стиля** (Fun, Calm, Oli — как в IluBoard) и **шесть фонов**: точки,
  линовка, крестики, каракули, сад, чистый. Настройки общие для всех досок.
- **PureRef:** файлы `.pur` открываются для просмотра — только картинки и их
  раскладка; «Сохранить как .ilucanvas» делает редактируемую копию. Формат 2.x
  проверен на реальном файле, 1.x — по описанию формата ([docs/PUREREF.md](docs/PUREREF.md)).
- **Ссылки на Google Диск:** поделитесь файлом «всем, у кого есть ссылка» —
  команда открывает доску по ссылке, файл скачивается к ним, обновления —
  кнопкой «Синхронизировать». Нужен ключ Google API: [docs/SHARING.md](docs/SHARING.md).
- **Для агентов:** CLI одним файлом без зависимостей и `window.ilucanvas` в
  открытой странице; приложение подхватывает изменения файла за пару секунд.
- Устанавливается как приложение (Chrome / Edge → «Установить»): тогда
  `.ilucanvas` и `.pur` открываются двойным кликом и работает без интернета.

## Для агента

```bash
curl -O https://ilumetric.github.io/IluCanvas/ilucanvas.mjs
node ilucanvas.mjs new refs.ilucanvas --title "Персонаж"
node ilucanvas.mjs add refs.ilucanvas refs/ https://example.com/a.jpg --new-group "Свет"
node ilucanvas.mjs ls refs.ilucanvas
node ilucanvas.mjs apply refs.ilucanvas ops.json     # много изменений за одну запись
node ilucanvas.mjs from-pur board.pur                # PureRef → .ilucanvas
```

Подробно: [docs/AGENT.md](docs/AGENT.md) · формат: [docs/FORMAT.md](docs/FORMAT.md) ·
схема: [schema/canvas.schema.json](schema/canvas.schema.json) · [llms.txt](llms.txt).

## Как пользоваться

1. Откройте https://ilumetric.github.io/IluCanvas/ в Chrome или Edge.
2. *Открыть папку* → папка, где будут жить доски. *Новый канвас* создаёт файл в ней.
3. Перетащите картинки или папки на доску, вставляйте из буфера (Ctrl+V).
   Колесо — масштаб к курсору, пробел или средняя кнопка — двигать доску.
4. Всё сохраняется само. Файл можно скопировать, отправить, положить в Google Диск.

**Firefox, Safari, встроенные браузеры** не умеют писать в файл на диске: там
доски открываются для просмотра, сохранение — скачиванием. Для встроенного
браузера есть локальный сервер:

```bash
node tools/serve.mjs путь/к/папке --port 8790
# http://localhost:8790/?file=доска.ilucanvas
```

## Разработка

Без сборки и зависимостей, Node 20+.

```bash
npm test               # node --test: ZIP, модель, CLI (исходник и бандл)
npm run bundle         # собрать ilucanvas.mjs из tools/ilucanvas.mjs + src/core/*
npm run serve          # локальный сервер на папке examples/
node test/pureref.sample.mjs file.pur out/   # разобрать .pur и выгрузить картинки
```

```
index.html            страница приложения (GitHub Pages отдаёт корень репозитория)
src/core/             без DOM: zip, canvasfile (формат), model, ops, imageinfo, pureref
src/app/              интерфейс: main, board (рисование и мышь), images (LOD-кэш),
                      store (документ и сохранение), disk, remote, minimap, background
tools/ilucanvas.mjs   CLI (исходник)     ilucanvas.mjs   CLI одним файлом (генерируется)
tools/serve.mjs       локальный сервер   tools/bundle.mjs  сборщик бандла
docs/ schema/ test/ examples/
```

## Лицензия

MIT
