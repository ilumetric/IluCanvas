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
  'welcome.new': 'Пустая доска — сразу в файл', 'welcome.newLocal': 'Пустая доска — хранится в этом браузере', 'welcome.folder': 'Все канвасы из папки — в панели слева',
  'welcome.file': '.ilucanvas или PureRef (.pur)', 'welcome.link': 'Google Диск и другие — смотреть доску команды',
  'welcome.local': 'Доски хранятся в этом браузере и сохраняются сами. «Скачать» сохраняет файл .ilucanvas (на iPad — в «Файлы»). На iPad добавьте сайт на экран «Домой», чтобы Safari не удалял их.',
  'side.local': 'В этом браузере', 'side.localEmpty': 'Новые и открытые доски хранятся здесь.',
  'local.delete': 'Удалить из браузера', 'local.deleteText': 'Доска «{name}» будет удалена из хранилища браузера. Если нужна копия — сначала скачайте её.',
  'local.download': 'Скачать файл .ilucanvas', 'local.importing': 'Копирую {name} в браузер…', 'local.imported': 'Доска скопирована в браузер — теперь её можно править. «Скачать» сохраняет файл.', 'local.kept': 'Копия сохранена в браузере — её можно править.',
  'top.keep': 'Сохранить в браузере',
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
  'link.about': 'Доска по ссылке открывается только для просмотра. Копия хранится в браузере (или в папке из настроек) и открывается без интернета.',
  'link.open': 'Открыть', 'link.downloading': 'Скачиваю… {p}%', 'link.downloadingMb': 'Скачиваю… {mb} МБ', 'link.sync': 'Синхронизировать',
  'link.synced': 'Доска обновлена до последней версии', 'link.upToDate': 'У вас последняя версия', 'link.updateAvailable': 'Есть обновление',
  'link.forget': 'Убрать доску', 'link.forgetText': 'Убрать «{name}» из списка и удалить скачанную копию? Файл по ссылке не пострадает.',
  'link.forgetTextFolder': 'Убрать «{name}» из списка? Скачанный файл {file} останется в папке.',
  'linkErr.http': 'Не удалось скачать: {msg}', 'linkErr.notfound': 'Файл не найден: ссылка неверна или файл закрыт',
  'linkErr.private': 'Нет доступа: откройте файл «Всем, у кого есть ссылка»', 'linkErr.nokey': 'На этом сайте не настроен ключ Google API (config.js)',
  'linkErr.badkey': 'Ключ Google API сайта не подходит (config.js)', 'linkErr.apidisabled': 'В проекте ключа не включён Google Drive API',
  'linkErr.referer': 'Ключ Google API не разрешён для этого сайта', 'linkErr.quota': 'Google ограничил скачивание — попробуйте позже',
  'linkErr.cors': 'Сайт не разрешает скачивать файл из браузера (CORS)',

  'settings.title': 'Настройки', 'settings.style': 'Стиль', 'settings.background': 'Фон', 'settings.bgNote': 'Стиль выбирает подходящий фон; его можно сменить. Настройки общие для всех досок.',
  'settings.wheel': 'Тачпад, два пальца', 'settings.wheelZoom': 'Масштаб', 'settings.wheelPan': 'Прокрутка', 'settings.wheelNote': 'Колесо мыши, Ctrl + колесо и щипок — всегда масштаб; Shift + колесо — вбок. Правая кнопка — двигать доску, средняя — масштаб.',
  'settings.autosave': 'Сохранение', 'settings.autosaveText': 'Сохранять автоматически (дописываются только изменения)',
  'settings.language': 'Язык',
  'settings.linksDir': 'Доски по ссылкам', 'settings.linksDirNote': 'Куда скачиваются доски, открытые по ссылке (Google Drive и др.). При синхронизации файл в папке заменяется новой версией. Уже скачанные доски переедут при следующей синхронизации.',
  'settings.linksDirNoApi': 'Хранятся в браузере. Выбрать папку на диске можно в Chrome или Edge.',
  'linksDir.browser': 'В хранилище браузера', 'linksDir.pick': 'Выбрать папку…', 'linksDir.change': 'Другая папка…', 'linksDir.reset': 'Хранить в браузере',
  'linksDir.noAccess': 'Нет доступа к папке «{name}» — разрешите, чтобы открыть доску', 'linksDir.allow': 'Разрешить',
  'linksDir.fallback': 'Нет доступа к папке «{name}» — доска скачана в хранилище браузера',
  'settings.keys': 'Горячие клавиши',

  'style.fun': 'Яркий и живой', 'style.calm': 'Спокойный и строгий', 'style.oli': 'Мягкий и нежный',
  'bg.dots': 'Точки', 'bg.grid': 'Линовка', 'bg.cross': 'Крестики', 'bg.doodle': 'Каракули', 'bg.garden': 'Сад', 'bg.plain': 'Чистый',

  'keys.rmb': 'Правая кнопка + тянуть', 'keys.mmb': 'Средняя кнопка + тянуть', 'keys.space': 'Пробел + тянуть', 'keys.pan': 'двигать доску', 'keys.wheel': 'Колесо', 'keys.zoom': 'масштаб к курсору',
  'keys.drag': 'перетаскивание', 'keys.dupDrag': 'копия', 'keys.axis': 'только по одной оси', 'keys.dbl': 'Двойной клик',

  'tool.shape': 'Фигура', 'tool.connector': 'Связь', 'tool.pen': 'Ручка', 'tool.highlighter': 'Маркер', 'tool.tape': 'Лента', 'tool.eraser': 'Ластик',
  'ink.round': 'Круглое перо', 'ink.italic': 'Каллиграфическое перо — поворот стилуса поворачивает перо', 'ink.width': 'Толщина', 'ink.color': 'Цвет', 'ink.tool': 'Инструмент',
  'zoom.snap': 'Привязка к краям и центрам (Ctrl при перетаскивании — без неё)', 'zoom.snapGrid': 'Привязка к сетке фона (Ctrl при перетаскивании — без неё)', 'sideGroup.new': 'Новая группа', 'sideGroup.name': 'Название группы', 'sideGroup.default': 'Группа', 'sideGroup.menu': 'Группа', 'sideGroup.rename': 'Переименовать группу', 'sideGroup.delete': 'Удалить группу (доски останутся)', 'sideGroup.empty': 'Перетащите сюда доски', 'sideGroup.boardMenu': 'В группу…', 'sideGroup.moveTo': 'В группу', 'sideGroup.newWith': 'Новая группа…', 'sideGroup.remove': 'Убрать из группы', 'sideGroup.missing': 'сейчас недоступна', 'sideGroup.missingText': 'Эта доска сейчас недоступна: откройте её папку или ссылку снова', 'tool.image': 'Картинки', 'tool.video': 'Видео по ссылке',
  'video.add': 'Добавить видео', 'video.link': 'Ссылка на YouTube', 'video.badLink': 'Это не ссылка на видео YouTube', 'video.loading': 'Загружаю обложку и название…', 'video.noPoster': 'Обложку скачать не удалось — видео добавлено без неё',
  'video.offline': 'YouTube недоступен — плеер не открыть', 'video.play': 'Смотреть', 'video.pause': 'Пауза', 'video.frameBack': 'Кадр назад', 'video.frameFwd': 'Кадр вперёд', 'video.speed': 'Скорость',
  'video.loopA': 'Начало петли A — сейчас', 'video.loopB': 'Конец петли B — сейчас', 'video.loopClear': 'Убрать петлю', 'video.openYoutube': 'Открыть на YouTube', 'video.close': 'Закрыть плеер',
  'video.mark': 'Метка', 'video.markAdd': 'Метка на {time}', 'video.markLabel': 'Что здесь (можно пусто)', 'video.markGo': 'Перейти', 'video.markRemove': 'Удалить метку',
  'color.custom': 'Свой цвет…', 'color.wheel': 'Тон и насыщенность', 'color.brightness': 'Яркость', 'color.h': 'Тон (H)', 'color.s': 'Насыщенность (S)', 'color.l': 'Светлота (L)', 'color.eyedropper': 'Пипетка — цвет с экрана',
  'shape.kind': 'Фигура', 'shape.fill': 'Заливка', 'shape.stroke': 'Обводка',
  'shape.rect': 'Прямоугольник', 'shape.rounded': 'Скруглённый', 'shape.ellipse': 'Эллипс', 'shape.diamond': 'Ромб',
  'shape.triangle': 'Треугольник', 'shape.parallelogram': 'Параллелограмм', 'shape.hexagon': 'Шестиугольник', 'shape.star': 'Звезда',
  'paint.none': 'Нет', 'paint.white': 'Белый', 'paint.grey': 'Серый', 'paint.black': 'Чёрный', 'paint.red': 'Красный', 'paint.orange': 'Оранжевый',
  'paint.yellow': 'Жёлтый', 'paint.green': 'Зелёный', 'paint.blue': 'Синий', 'paint.violet': 'Фиолетовый', 'paint.pink': 'Розовый',
  'route.straight': 'Прямая', 'route.elbow': 'Ломаная', 'route.curve': 'Кривая', 'route.dubins': 'Путь Дубинса (дуги и прямые)',
  'conn.start': 'Начало', 'conn.end': 'Конец', 'conn.color': 'Цвет линии', 'conn.width': 'Толщина', 'conn.dash': 'Пунктир', 'ink.arrow': 'Стрелка на конце', 'conn.label': 'Подпись',
  'conn.thin': 'Тонкая', 'conn.medium': 'Средняя', 'conn.thick': 'Толстая', 'conn.bold': 'Жирная', 'conn.heavy': 'Очень толстая', 'shape.strokeWidth': 'Толщина обводки', 'shape.widthAuto': 'По размеру фигуры', 'shape.line': 'Линия', 'shape.arrow': 'Стрелка',
  'head.none': 'Без конца', 'head.arrow': 'Стрелка', 'head.dot': 'Точка',
  'tool.note': 'Заметка', 'tool.noteDrag': 'клик или перетащите на доску', 'settings.ui': 'Масштаб интерфейса',
  'note.color': 'Цвет', 'note.sticky': 'Стикер', 'note.doc': 'Документ', 'note.text': 'Текст', 'note.size': 'Размер текста', 'note.edit': 'Редактировать текст',
  'noteColor.yellow': 'Жёлтый', 'noteColor.orange': 'Оранжевый', 'noteColor.pink': 'Розовый', 'noteColor.green': 'Зелёный', 'noteColor.blue': 'Голубой',
  'noteColor.violet': 'Сиреневый', 'noteColor.grey': 'Серый', 'noteColor.paper': 'Бумага', 'noteColor.none': 'Без фона',
  'fmt.left': 'По левому краю', 'fmt.center': 'По центру', 'fmt.right': 'По правому краю', 'fmt.style': 'Стиль абзаца',
  'fmt.p': 'Текст', 'fmt.h1': 'Заголовок 1', 'fmt.h2': 'Заголовок 2', 'fmt.h3': 'Заголовок 3', 'fmt.quote': 'Цитата',
  'fmt.bold': 'Жирный', 'fmt.italic': 'Курсив', 'fmt.underline': 'Подчёркнутый', 'fmt.strike': 'Зачёркнутый',
  'fmt.ul': 'Список', 'fmt.ol': 'Нумерованный список', 'fmt.task': 'Чек-лист',
  'fmt.color': 'Цвет текста', 'fmt.noColor': 'Обычный цвет', 'fmt.highlight': 'Маркер', 'fmt.noHighlight': 'Без маркера',
  'fmt.link': 'Ссылка', 'fmt.linkUrl': 'Адрес', 'fmt.done': 'Готово',
  'markColor.red': 'Красный', 'markColor.orange': 'Оранжевый', 'markColor.yellow': 'Жёлтый', 'markColor.green': 'Зелёный',
  'markColor.blue': 'Синий', 'markColor.violet': 'Фиолетовый', 'markColor.pink': 'Розовый', 'markColor.grey': 'Серый',
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
  'welcome.new': 'An empty board, saved to a file', 'welcome.newLocal': 'An empty board, kept in this browser', 'welcome.folder': 'Every canvas in a folder, in the left panel',
  'welcome.file': '.ilucanvas or PureRef (.pur)', 'welcome.link': 'Google Drive and others — view your team’s board',
  'welcome.local': 'Boards are kept in this browser and save themselves. Download saves an .ilucanvas file (on iPad: to Files). On iPad add the site to the Home Screen so Safari keeps them.',
  'side.local': 'In this browser', 'side.localEmpty': 'New and opened boards are kept here.',
  'local.delete': 'Delete from the browser', 'local.deleteText': 'The board “{name}” will be deleted from the browser storage. Download it first if you need a copy.',
  'local.download': 'Download the .ilucanvas file', 'local.importing': 'Copying {name} into the browser…', 'local.imported': 'The board is copied into the browser and editable now. Download saves a file.', 'local.kept': 'A copy is kept in the browser and editable.',
  'top.keep': 'Keep in browser',
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
  'link.about': 'A board from a link opens view only. A copy is kept in the browser (or in the folder from Settings) and opens offline.',
  'link.open': 'Open', 'link.downloading': 'Downloading… {p}%', 'link.downloadingMb': 'Downloading… {mb} MB', 'link.sync': 'Sync',
  'link.synced': 'Board updated to the latest version', 'link.upToDate': 'You have the latest version', 'link.updateAvailable': 'Update available',
  'link.forget': 'Remove board', 'link.forgetText': 'Remove “{name}” from the list and delete the downloaded copy? The linked file stays as it is.',
  'link.forgetTextFolder': 'Remove “{name}” from the list? The downloaded file {file} stays in the folder.',
  'linkErr.http': 'Download failed: {msg}', 'linkErr.notfound': 'File not found: wrong link, or the file is not shared',
  'linkErr.private': 'No access: share the file with “Anyone with the link”', 'linkErr.nokey': 'This site has no Google API key set up (config.js)',
  'linkErr.badkey': 'The site’s Google API key does not work (config.js)', 'linkErr.apidisabled': 'Google Drive API is not enabled in the key’s project',
  'linkErr.referer': 'The Google API key is not allowed on this site', 'linkErr.quota': 'Google limited downloads — try later',
  'linkErr.cors': 'The site does not allow downloading the file from a browser (CORS)',

  'settings.title': 'Settings', 'settings.style': 'Style', 'settings.background': 'Background', 'settings.bgNote': 'A style picks a matching background; you can change it. Settings apply to every board.',
  'settings.wheel': 'Trackpad, two fingers', 'settings.wheelZoom': 'Zoom', 'settings.wheelPan': 'Scroll', 'settings.wheelNote': 'The mouse wheel, Ctrl + wheel and a pinch always zoom; Shift + wheel scrolls sideways. Right button drags the board, middle button zooms.',
  'settings.autosave': 'Saving', 'settings.autosaveText': 'Save automatically (only the changes are written)',
  'settings.language': 'Language',
  'settings.linksDir': 'Boards from links', 'settings.linksDirNote': 'Where boards opened by link (Google Drive and others) are downloaded. A sync replaces the file in the folder with the new version. Boards downloaded earlier move there on their next sync.',
  'settings.linksDirNoApi': 'Kept in the browser. Picking a folder on disk works in Chrome or Edge.',
  'linksDir.browser': 'In the browser’s storage', 'linksDir.pick': 'Choose folder…', 'linksDir.change': 'Another folder…', 'linksDir.reset': 'Keep in the browser',
  'linksDir.noAccess': 'No access to the folder “{name}” — allow it to open the board', 'linksDir.allow': 'Allow',
  'linksDir.fallback': 'No access to the folder “{name}” — the board was downloaded into the browser’s storage',
  'settings.keys': 'Shortcuts',

  'style.fun': 'Bright and lively', 'style.calm': 'Quiet and plain', 'style.oli': 'Soft and gentle',
  'bg.dots': 'Dots', 'bg.grid': 'Grid', 'bg.cross': 'Crosses', 'bg.doodle': 'Doodles', 'bg.garden': 'Garden', 'bg.plain': 'Plain',

  'keys.rmb': 'Right button + drag', 'keys.mmb': 'Middle button + drag', 'keys.space': 'Space + drag', 'keys.pan': 'move the board', 'keys.wheel': 'Wheel', 'keys.zoom': 'zoom to the cursor',
  'keys.drag': 'drag', 'keys.dupDrag': 'a copy', 'keys.axis': 'one axis only', 'keys.dbl': 'Double click',

  'tool.shape': 'Shape', 'tool.connector': 'Connector', 'tool.pen': 'Pen', 'tool.highlighter': 'Highlighter', 'tool.tape': 'Tape', 'tool.eraser': 'Eraser',
  'ink.round': 'Round nib', 'ink.italic': 'Italic nib — turning the stylus turns it', 'ink.width': 'Width', 'ink.color': 'Colour', 'ink.tool': 'Tool',
  'zoom.snap': 'Snap to edges and centres (hold Ctrl while dragging to skip)', 'zoom.snapGrid': 'Snap to the background grid (hold Ctrl while dragging to skip)', 'sideGroup.new': 'New group', 'sideGroup.name': 'Group name', 'sideGroup.default': 'Group', 'sideGroup.menu': 'Group', 'sideGroup.rename': 'Rename the group', 'sideGroup.delete': 'Delete the group (the boards stay)', 'sideGroup.empty': 'Drag boards here', 'sideGroup.boardMenu': 'Into a group…', 'sideGroup.moveTo': 'Into the group', 'sideGroup.newWith': 'New group…', 'sideGroup.remove': 'Take out of the group', 'sideGroup.missing': 'not available now', 'sideGroup.missingText': 'This board is not available now: open its folder or link again', 'tool.image': 'Pictures', 'tool.video': 'Video by link',
  'video.add': 'Add a video', 'video.link': 'YouTube link', 'video.badLink': 'This is not a YouTube video link', 'video.loading': 'Fetching the poster and title…', 'video.noPoster': 'Could not download the poster — the video is added without it',
  'video.offline': 'YouTube is not reachable — the player cannot open', 'video.play': 'Play', 'video.pause': 'Pause', 'video.frameBack': 'Previous frame', 'video.frameFwd': 'Next frame', 'video.speed': 'Speed',
  'video.loopA': 'Loop start A — now', 'video.loopB': 'Loop end B — now', 'video.loopClear': 'Clear the loop', 'video.openYoutube': 'Open on YouTube', 'video.close': 'Close the player',
  'video.mark': 'Mark', 'video.markAdd': 'Mark at {time}', 'video.markLabel': 'What happens here (may be empty)', 'video.markGo': 'Go there', 'video.markRemove': 'Remove the mark',
  'color.custom': 'Custom colour…', 'color.wheel': 'Hue and saturation', 'color.brightness': 'Brightness', 'color.h': 'Hue (H)', 'color.s': 'Saturation (S)', 'color.l': 'Lightness (L)', 'color.eyedropper': 'Eyedropper — pick a colour on screen',
  'shape.kind': 'Shape', 'shape.fill': 'Fill', 'shape.stroke': 'Outline',
  'shape.rect': 'Rectangle', 'shape.rounded': 'Rounded', 'shape.ellipse': 'Ellipse', 'shape.diamond': 'Diamond',
  'shape.triangle': 'Triangle', 'shape.parallelogram': 'Parallelogram', 'shape.hexagon': 'Hexagon', 'shape.star': 'Star',
  'paint.none': 'None', 'paint.white': 'White', 'paint.grey': 'Grey', 'paint.black': 'Black', 'paint.red': 'Red', 'paint.orange': 'Orange',
  'paint.yellow': 'Yellow', 'paint.green': 'Green', 'paint.blue': 'Blue', 'paint.violet': 'Violet', 'paint.pink': 'Pink',
  'route.straight': 'Straight', 'route.elbow': 'Elbow', 'route.curve': 'Curve', 'route.dubins': 'Dubins path (arcs and lines)',
  'conn.start': 'Start', 'conn.end': 'End', 'conn.color': 'Line colour', 'conn.width': 'Width', 'conn.dash': 'Dashed', 'ink.arrow': 'Arrow at the end', 'conn.label': 'Label',
  'conn.thin': 'Thin', 'conn.medium': 'Medium', 'conn.thick': 'Thick', 'conn.bold': 'Bold', 'conn.heavy': 'Heavy', 'shape.strokeWidth': 'Outline width', 'shape.widthAuto': 'With the shape\'s size', 'shape.line': 'Line', 'shape.arrow': 'Arrow',
  'head.none': 'No end', 'head.arrow': 'Arrow', 'head.dot': 'Dot',
  'tool.note': 'Note', 'tool.noteDrag': 'click, or drag onto the board', 'settings.ui': 'Interface scale',
  'note.color': 'Colour', 'note.sticky': 'Sticky', 'note.doc': 'Document', 'note.text': 'Text', 'note.size': 'Text size', 'note.edit': 'Edit text',
  'noteColor.yellow': 'Yellow', 'noteColor.orange': 'Orange', 'noteColor.pink': 'Pink', 'noteColor.green': 'Green', 'noteColor.blue': 'Blue',
  'noteColor.violet': 'Lilac', 'noteColor.grey': 'Grey', 'noteColor.paper': 'Paper', 'noteColor.none': 'No paper',
  'fmt.left': 'Align left', 'fmt.center': 'Centre', 'fmt.right': 'Align right', 'fmt.style': 'Paragraph style',
  'fmt.p': 'Text', 'fmt.h1': 'Heading 1', 'fmt.h2': 'Heading 2', 'fmt.h3': 'Heading 3', 'fmt.quote': 'Quote',
  'fmt.bold': 'Bold', 'fmt.italic': 'Italic', 'fmt.underline': 'Underline', 'fmt.strike': 'Strikethrough',
  'fmt.ul': 'List', 'fmt.ol': 'Numbered list', 'fmt.task': 'Checklist',
  'fmt.color': 'Text colour', 'fmt.noColor': 'Plain colour', 'fmt.highlight': 'Highlight', 'fmt.noHighlight': 'No highlight',
  'fmt.link': 'Link', 'fmt.linkUrl': 'Address', 'fmt.done': 'Done',
  'markColor.red': 'Red', 'markColor.orange': 'Orange', 'markColor.yellow': 'Yellow', 'markColor.green': 'Green',
  'markColor.blue': 'Blue', 'markColor.violet': 'Violet', 'markColor.pink': 'Pink', 'markColor.grey': 'Grey',
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
