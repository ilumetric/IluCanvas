// Interface strings, Russian and English. t('key', { var }) → text; {var} is replaced.

const RU = {
  untitled: 'Без названия',
  unload: 'Есть несохранённые изменения.',
  'dlg.ok': 'Готово', 'dlg.cancel': 'Отмена', 'dlg.close': 'Закрыть',

  'side.new': 'Новый канвас', 'side.openFolder': 'Открыть папку', 'side.openFile': 'Открыть файл', 'side.openLink': 'Открыть по ссылке',
  'side.recent': 'Недавние', 'side.recentEmpty': 'Откройте папку с канвасами — они появятся здесь', 'side.links': 'По ссылке',
  'side.settings': 'Настройки', 'side.agents': 'Для агентов', 'side.collapse': 'Скрыть панель', 'side.open': 'Показать панель',
  'side.forget': 'Убрать из списка', 'side.rescan': 'Обновить список', 'side.closeFolder': 'Закрыть папку',
  'side.grant': 'Разрешить доступ к папке', 'side.folderEmpty': 'Канвасов пока нет',

  'state.saving': 'Сохраняю…', 'state.error': 'Не сохранилось', 'state.pur': 'PureRef · просмотр', 'state.link': 'По ссылке · просмотр',
  'state.readonly': 'Только просмотр', 'state.noFile': 'Не сохранено в файл', 'state.unsaved': 'Не сохранено', 'state.saved': 'Сохранено',

  'top.menu': 'Меню канваса', 'top.undo': 'Отменить', 'top.redo': 'Повторить', 'top.save': 'Сохранить', 'top.saveAs': 'Сохранить как…',
  'top.savePur': 'Сохранить как .ilucanvas', 'top.download': 'Скачать',
  'tool.select': 'Выделение', 'tool.hand': 'Рука',

  'zoom.in': 'Приблизить', 'zoom.out': 'Отдалить', 'zoom.fit': 'Показать всё', 'zoom.selection': 'К выделенному', 'zoom.map': 'Миникарта', 'zoom.menu': 'Масштаб',

  'welcome.sub': 'Бесконечная доска для референсов. Всё хранится в одном файле .ilucanvas на вашем диске — внутри обычный ZIP с вашими картинками.',
  'welcome.new': 'Пустая доска — сразу в файл', 'welcome.folder': 'Все канвасы из папки — в панели слева',
  'welcome.file': '.ilucanvas или PureRef (.pur)', 'welcome.link': 'Google Диск и другие — смотреть доску команды',
  'welcome.noFsa': 'Этот браузер не умеет сохранять в файл на диске: открыть и посмотреть можно, сохранить — только скачиванием. Для работы откройте в Chrome или Edge.',
  'welcome.agents': 'Для AI-агентов:',

  'leave.title': 'Несохранённые изменения', 'leave.text': 'Канвас ещё не сохранён в файл. Сохранить его?', 'leave.discard': 'Не сохранять',
  'leave.failed': 'Сохранить не получилось. Закрыть без сохранения?',

  'open.loading': 'Открываю {name}…', 'open.failed': 'Не удалось открыть: {msg}', 'open.permission': 'Нет доступа к файлу — разрешите его в запросе браузера',
  'open.warnings': 'Открыто с предупреждениями ({n}): {first}', 'open.invalid': 'В файле ошибки ({n}): {first}',
  'open.pur': 'Файл PureRef открыт для просмотра. Чтобы редактировать — сохраните его как .ilucanvas.',
  'folder.empty': 'В папке «{name}» пока нет канвасов',
  'new.title': 'Новый канвас',
  'reload.confirm': 'Несохранённые изменения пропадут. Перечитать файл?',

  'save.failed': 'Не сохранилось: {msg}', 'save.writing': 'Сохраняю…', 'save.packing': 'Собираю файл…', 'save.savedAs': 'Сохранено: {name}',
  'save.compacted': 'Файл сжат: удалённые картинки больше не занимают место', 'save.compacting': 'Сжимаю файл…',

  'ext.agent': 'агент', 'ext.someone': 'кто-то', 'ext.reloaded': 'Файл изменил {by} — доска обновлена',
  'ext.merged': 'Файл изменил {by}; изменения объединены, у {n} объектов оставлена ваша версия',

  'add.progress': 'Добавляю картинки: {done} из {n}', 'add.readonly': 'Эта доска только для просмотра — сохраните копию, чтобы менять',
  'add.unsupported': 'Не получилось добавить ({n}): {names}',
  'add.webBlocked': 'Сайт не даёт скачать картинку. Скопируйте её (правый клик → Копировать изображение) и вставьте сюда: Ctrl+V',

  'group.name': 'Группа {n}', 'group.rename': 'Переименовать',
  'export.done': 'Сохранено картинок: {n} → {dir}',

  'menu.rename': 'Переименовать канвас', 'menu.addImages': 'Добавить картинки…', 'menu.download': 'Скачать копию (.ilucanvas)',
  'menu.exportAll': 'Выгрузить все картинки в папку…', 'menu.compact': 'Сжать файл (освободить {mb} МБ)', 'menu.reload': 'Перечитать с диска',
  'menu.info': 'О файле', 'menu.close': 'Закрыть канвас',

  'info.file': 'Файл', 'info.format': 'Формат', 'info.images': 'Картинки', 'info.files': 'файлов', 'info.groups': 'Группы', 'info.size': 'Размер',
  'info.dead': 'из них {mb} МБ — от удалённого', 'info.updated': 'Изменён', 'info.check': 'Проверка', 'info.ok': 'всё в порядке', 'info.errors': 'ошибок',
  'info.zipNote': 'Файл .ilucanvas — обычный ZIP: переименуйте копию в .zip, и внутри будут canvas.json и папка images/ с оригиналами картинок.',

  'ctx.paste': 'Вставить', 'ctx.selectAll': 'Выделить всё', 'ctx.zoomTo': 'Приблизить', 'ctx.openOriginal': 'Открыть оригинал',
  'ctx.group': 'Сгруппировать', 'ctx.ungroup': 'Разгруппировать', 'ctx.arrange': 'Упорядочить', 'ctx.fitGroup': 'Подогнать рамку',
  'ctx.color': 'Цвет', 'ctx.flipH': 'Отразить по горизонтали', 'ctx.flipV': 'Отразить по вертикали', 'ctx.rotateRight': 'Повернуть на 90° вправо',
  'ctx.rotateLeft': 'Повернуть на 90° влево', 'ctx.reset': 'Сбросить поворот и отражение', 'ctx.natural': 'Исходный размер (1:1)',
  'ctx.sameHeight': 'Одинаковая высота', 'ctx.front': 'На передний план', 'ctx.back': 'На задний план', 'ctx.lock': 'Закрепить', 'ctx.unlock': 'Открепить',
  'ctx.copy': 'Копировать', 'ctx.duplicate': 'Дублировать', 'ctx.saveImage': 'Сохранить картинку', 'ctx.exportImages': 'Выгрузить картинки…', 'ctx.delete': 'Удалить',

  'color.violet': 'Фиолетовый', 'color.blue': 'Синий', 'color.orange': 'Оранжевый', 'color.green': 'Зелёный', 'color.pink': 'Розовый',
  'color.yellow': 'Жёлтый', 'color.red': 'Красный', 'color.amber': 'Янтарный', 'color.grey': 'Серый',

  'link.label': 'Ссылка на файл', 'link.hint': 'Google Диск: «Поделиться» → «Все, у кого есть ссылка» → «Копировать ссылку»',
  'link.bad': 'Это не похоже на ссылку', 'link.needKey': 'На этом сайте не настроен ключ Google API (config.js)',
  'link.drive': 'Google Диск: файл скачается к вам, обновления — кнопкой «Синхронизировать»', 'link.url': 'Прямая ссылка: сайт должен разрешать скачивание (CORS)',
  'link.about': 'Доска по ссылке открывается только для просмотра. Копия хранится в браузере и открывается без интернета.',
  'link.open': 'Открыть', 'link.downloading': 'Скачиваю… {p}%', 'link.downloadingMb': 'Скачиваю… {mb} МБ', 'link.sync': 'Синхронизировать',
  'link.synced': 'Доска обновлена до последней версии', 'link.upToDate': 'У вас последняя версия', 'link.updateAvailable': 'Есть обновление',
  'link.forget': 'Убрать доску', 'link.forgetText': 'Убрать «{name}» из списка и удалить скачанную копию? Файл по ссылке не пострадает.',
  'linkErr.http': 'Не удалось скачать: {msg}', 'linkErr.notfound': 'Файл не найден: ссылка неверна или файл закрыт',
  'linkErr.private': 'Нет доступа: откройте файл «Всем, у кого есть ссылка»', 'linkErr.nokey': 'На этом сайте не настроен ключ Google API (config.js)',
  'linkErr.badkey': 'Ключ Google API сайта не подходит (config.js)', 'linkErr.apidisabled': 'В проекте ключа не включён Google Drive API',
  'linkErr.referer': 'Ключ Google API не разрешён для этого сайта', 'linkErr.quota': 'Google ограничил скачивание — попробуйте позже',
  'linkErr.cors': 'Сайт не разрешает скачивать файл из браузера (CORS)',

  'settings.title': 'Настройки', 'settings.style': 'Стиль', 'settings.background': 'Фон', 'settings.bgNote': 'Стиль выбирает подходящий фон; его можно сменить. Настройки общие для всех досок.',
  'settings.wheel': 'Колесо мыши', 'settings.wheelZoom': 'Масштаб', 'settings.wheelPan': 'Прокрутка', 'settings.wheelNote': 'Ctrl + колесо и щипок на тачпаде — всегда масштаб; Shift + колесо — вбок.',
  'settings.autosave': 'Сохранение', 'settings.autosaveText': 'Сохранять автоматически (дописываются только изменения)',
  'settings.language': 'Язык',
  'settings.keys': 'Горячие клавиши',

  'style.fun': 'Яркий и живой', 'style.calm': 'Спокойный и строгий', 'style.oli': 'Мягкий и нежный',
  'bg.dots': 'Точки', 'bg.grid': 'Линовка', 'bg.cross': 'Крестики', 'bg.doodle': 'Каракули', 'bg.garden': 'Сад', 'bg.plain': 'Чистый',

  'keys.space': 'Пробел + тянуть', 'keys.pan': 'двигать доску', 'keys.wheel': 'Колесо', 'keys.zoom': 'масштаб к курсору',
  'keys.drag': 'перетаскивание', 'keys.dupDrag': 'копия', 'keys.axis': 'только по одной оси', 'keys.dbl': 'Двойной клик',

  'demo.title': 'Демо', 'demo.group1': 'Свет', 'demo.group2': 'Цвет', 'demo.group3': 'Формы',
};

const EN = {
  untitled: 'Untitled',
  unload: 'There are unsaved changes.',
  'dlg.ok': 'Done', 'dlg.cancel': 'Cancel', 'dlg.close': 'Close',

  'side.new': 'New canvas', 'side.openFolder': 'Open folder', 'side.openFile': 'Open file', 'side.openLink': 'Open link',
  'side.recent': 'Recent', 'side.recentEmpty': 'Open a folder of canvases — they show up here', 'side.links': 'From links',
  'side.settings': 'Settings', 'side.agents': 'For agents', 'side.collapse': 'Hide panel', 'side.open': 'Show panel',
  'side.forget': 'Remove from list', 'side.rescan': 'Refresh', 'side.closeFolder': 'Close folder',
  'side.grant': 'Allow access to the folder', 'side.folderEmpty': 'No canvases yet',

  'state.saving': 'Saving…', 'state.error': 'Not saved', 'state.pur': 'PureRef · view only', 'state.link': 'From a link · view only',
  'state.readonly': 'View only', 'state.noFile': 'Not saved to a file', 'state.unsaved': 'Unsaved', 'state.saved': 'Saved',

  'top.menu': 'Canvas menu', 'top.undo': 'Undo', 'top.redo': 'Redo', 'top.save': 'Save', 'top.saveAs': 'Save as…',
  'top.savePur': 'Save as .ilucanvas', 'top.download': 'Download',
  'tool.select': 'Select', 'tool.hand': 'Hand',

  'zoom.in': 'Zoom in', 'zoom.out': 'Zoom out', 'zoom.fit': 'Show everything', 'zoom.selection': 'Zoom to selection', 'zoom.map': 'Minimap', 'zoom.menu': 'Zoom',

  'welcome.sub': 'An infinite board for references. Everything lives in one .ilucanvas file on your disk — a plain ZIP with your pictures inside.',
  'welcome.new': 'An empty board, saved to a file', 'welcome.folder': 'Every canvas in a folder, in the left panel',
  'welcome.file': '.ilucanvas or PureRef (.pur)', 'welcome.link': 'Google Drive and others — view your team’s board',
  'welcome.noFsa': 'This browser cannot save into a file on disk: you can open and view, saving downloads a copy. Use Chrome or Edge to work.',
  'welcome.agents': 'For AI agents:',

  'leave.title': 'Unsaved changes', 'leave.text': 'This canvas is not saved to a file yet. Save it?', 'leave.discard': 'Don’t save',
  'leave.failed': 'Saving failed. Close without saving?',

  'open.loading': 'Opening {name}…', 'open.failed': 'Could not open: {msg}', 'open.permission': 'No access to the file — allow it in the browser prompt',
  'open.warnings': 'Opened with warnings ({n}): {first}', 'open.invalid': 'The file has errors ({n}): {first}',
  'open.pur': 'PureRef file opened for viewing. To edit it, save it as .ilucanvas.',
  'folder.empty': 'No canvases in “{name}” yet',
  'new.title': 'New canvas',
  'reload.confirm': 'Unsaved changes will be lost. Read the file again?',

  'save.failed': 'Not saved: {msg}', 'save.writing': 'Saving…', 'save.packing': 'Packing the file…', 'save.savedAs': 'Saved: {name}',
  'save.compacted': 'File compacted: deleted pictures no longer take space', 'save.compacting': 'Compacting…',

  'ext.agent': 'an agent', 'ext.someone': 'someone', 'ext.reloaded': '{by} changed the file — board updated',
  'ext.merged': '{by} changed the file; changes merged, your version kept for {n} objects',

  'add.progress': 'Adding pictures: {done} of {n}', 'add.readonly': 'This board is view only — save a copy to change it',
  'add.unsupported': 'Could not add ({n}): {names}',
  'add.webBlocked': 'The site does not allow downloading the picture. Copy it (right click → Copy image) and paste here: Ctrl+V',

  'group.name': 'Group {n}', 'group.rename': 'Rename',
  'export.done': 'Saved {n} pictures → {dir}',

  'menu.rename': 'Rename canvas', 'menu.addImages': 'Add pictures…', 'menu.download': 'Download a copy (.ilucanvas)',
  'menu.exportAll': 'Export all pictures to a folder…', 'menu.compact': 'Compact the file (free {mb} MB)', 'menu.reload': 'Read from disk again',
  'menu.info': 'About this file', 'menu.close': 'Close canvas',

  'info.file': 'File', 'info.format': 'Format', 'info.images': 'Pictures', 'info.files': 'files', 'info.groups': 'Groups', 'info.size': 'Size',
  'info.dead': '{mb} MB of it from deleted things', 'info.updated': 'Changed', 'info.check': 'Check', 'info.ok': 'all good', 'info.errors': 'errors',
  'info.zipNote': 'A .ilucanvas file is a plain ZIP: rename a copy to .zip and you will find canvas.json and an images/ folder with the original pictures.',

  'ctx.paste': 'Paste', 'ctx.selectAll': 'Select all', 'ctx.zoomTo': 'Zoom in', 'ctx.openOriginal': 'Open original',
  'ctx.group': 'Group', 'ctx.ungroup': 'Ungroup', 'ctx.arrange': 'Arrange', 'ctx.fitGroup': 'Fit frame',
  'ctx.color': 'Colour', 'ctx.flipH': 'Flip horizontally', 'ctx.flipV': 'Flip vertically', 'ctx.rotateRight': 'Rotate 90° right',
  'ctx.rotateLeft': 'Rotate 90° left', 'ctx.reset': 'Reset rotation and flip', 'ctx.natural': 'Original size (1:1)',
  'ctx.sameHeight': 'Same height', 'ctx.front': 'Bring to front', 'ctx.back': 'Send to back', 'ctx.lock': 'Lock', 'ctx.unlock': 'Unlock',
  'ctx.copy': 'Copy', 'ctx.duplicate': 'Duplicate', 'ctx.saveImage': 'Save picture', 'ctx.exportImages': 'Export pictures…', 'ctx.delete': 'Delete',

  'color.violet': 'Violet', 'color.blue': 'Blue', 'color.orange': 'Orange', 'color.green': 'Green', 'color.pink': 'Pink',
  'color.yellow': 'Yellow', 'color.red': 'Red', 'color.amber': 'Amber', 'color.grey': 'Grey',

  'link.label': 'Link to the file', 'link.hint': 'Google Drive: Share → “Anyone with the link” → Copy link',
  'link.bad': 'This does not look like a link', 'link.needKey': 'This site has no Google API key set up (config.js)',
  'link.drive': 'Google Drive: the file downloads to you, updates come with “Sync”', 'link.url': 'Direct link: the site must allow downloads (CORS)',
  'link.about': 'A board from a link opens view only. A copy is kept in the browser and opens offline.',
  'link.open': 'Open', 'link.downloading': 'Downloading… {p}%', 'link.downloadingMb': 'Downloading… {mb} MB', 'link.sync': 'Sync',
  'link.synced': 'Board updated to the latest version', 'link.upToDate': 'You have the latest version', 'link.updateAvailable': 'Update available',
  'link.forget': 'Remove board', 'link.forgetText': 'Remove “{name}” from the list and delete the downloaded copy? The linked file stays as it is.',
  'linkErr.http': 'Download failed: {msg}', 'linkErr.notfound': 'File not found: wrong link, or the file is not shared',
  'linkErr.private': 'No access: share the file with “Anyone with the link”', 'linkErr.nokey': 'This site has no Google API key set up (config.js)',
  'linkErr.badkey': 'The site’s Google API key does not work (config.js)', 'linkErr.apidisabled': 'Google Drive API is not enabled in the key’s project',
  'linkErr.referer': 'The Google API key is not allowed on this site', 'linkErr.quota': 'Google limited downloads — try later',
  'linkErr.cors': 'The site does not allow downloading the file from a browser (CORS)',

  'settings.title': 'Settings', 'settings.style': 'Style', 'settings.background': 'Background', 'settings.bgNote': 'A style picks a matching background; you can change it. Settings apply to every board.',
  'settings.wheel': 'Mouse wheel', 'settings.wheelZoom': 'Zoom', 'settings.wheelPan': 'Scroll', 'settings.wheelNote': 'Ctrl + wheel and trackpad pinch always zoom; Shift + wheel scrolls sideways.',
  'settings.autosave': 'Saving', 'settings.autosaveText': 'Save automatically (only the changes are written)',
  'settings.language': 'Language',
  'settings.keys': 'Shortcuts',

  'style.fun': 'Bright and lively', 'style.calm': 'Quiet and plain', 'style.oli': 'Soft and gentle',
  'bg.dots': 'Dots', 'bg.grid': 'Grid', 'bg.cross': 'Crosses', 'bg.doodle': 'Doodles', 'bg.garden': 'Garden', 'bg.plain': 'Plain',

  'keys.space': 'Space + drag', 'keys.pan': 'move the board', 'keys.wheel': 'Wheel', 'keys.zoom': 'zoom to the cursor',
  'keys.drag': 'drag', 'keys.dupDrag': 'a copy', 'keys.axis': 'one axis only', 'keys.dbl': 'Double click',

  'demo.title': 'Demo', 'demo.group1': 'Light', 'demo.group2': 'Colour', 'demo.group3': 'Shapes',
};

let lang = 'ru';
const DICT = { ru: RU, en: EN };

export function setLang(l) {
  lang = l === 'en' ? 'en' : 'ru';
  document.documentElement.lang = lang;
}
export const getLang = () => lang;

export function t(key, vars) {
  let s = DICT[lang][key] ?? RU[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  return s;
}
