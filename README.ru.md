[English](README.md) | **Русский**

# claude-code-kit

[![CI](https://github.com/profax/claude-code-kit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/profax/claude-code-kit/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/profax/claude-code-kit)](https://github.com/profax/claude-code-kit/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Три дополнения к Claude Code в терминале: посмотреть вставленную картинку до
отправки, заглянуть в файл, который назван в ответе, и держать лимиты в
строке состояния.

| Часть | Что делает | Где работает |
|---|---|---|
| [image-preview](#image-preview) | Наведите указатель на `[Image #N]` и увидите картинку | macOS, Linux, Windows, WSL |
| [quick-peek](#quick-peek) | Пути в ответах становятся ссылками с карточкой файла | macOS, Linux, Windows, WSL |
| [quotaline](#quotaline) | Строка состояния: контекст, лимиты, время до их сброса | Любой терминал |

Части не зависят друг от друга. Ставьте те, что нужны.

## Установка

### Плагины

Нужен Claude Code 2.1.325 или новее.

```
/plugin marketplace add profax/claude-code-kit
/plugin install image-preview@claude-code-kit
/plugin install quick-peek@claude-code-kit
```

Затем один раз выполните `/tui fullscreen`. Терминал сообщает об указателе
только в полноэкранном интерфейсе, а оба плагина работают по наведению. В tmux
нужна ещё строка `set -g mouse on`.

### quotaline

1. Скачайте архив для своей системы со страницы
   [Releases](https://github.com/profax/claude-code-kit/releases), распакуйте
   и положите `quotaline` туда, где держите программы, например в
   `~/.local/bin`.
2. Выполните `quotaline --setup`. Без аргументов `quotaline` печатает справку.

Программа покажет, что собирается изменить в настройках Claude Code, спросит
согласия и сохранит копию прежнего файла:

```
$ quotaline --setup
quotaline will add this to /Users/you/.claude/settings.json:

  "statusLine": {
    "type": "command",
    "command": "/Users/you/.local/bin/quotaline",
    "refreshInterval": 60
  }

Write it? [y/N] y
Added the status line to /Users/you/.claude/settings.json.
```

Открытые сессии подхватят строку без перезапуска. Если в настройках строкой
состояния уже названа другая программа, quotaline её не тронет и напечатает,
что поменять вручную.

Собрать из исходного кода (Rust 1.89 или новее):

```
cargo install --locked --git https://github.com/profax/claude-code-kit quotaline
```

<details>
<summary>Настройка вручную</summary>

Добавьте это в `~/.claude/settings.json`, с полным путём к программе. В
Windows путь пишется с прямыми косыми, например
`C:/Users/you/bin/quotaline.exe`: так его исполняют и Git Bash, и PowerShell.

```json
"statusLine": {
  "type": "command",
  "command": "/Users/you/.local/bin/quotaline",
  "refreshInterval": 60
}
```

</details>

## image-preview

Вставьте картинку, и над полем ввода появится метка `[Image #N]`. Наведите на
неё указатель, чтобы увидеть картинку; щелчок открывает её в программе
просмотра системы. То же работает на уже отправленных запросах.

Как рисуется картинка, зависит от терминала:

- Ghostty и kitty рисуют саму картинку.
- В Windows и под WSL она открывается в небольшом окне у указателя, в tmux
  тоже. Окно не забирает фокус и закрывается, когда указатель уходит.
- Любой другой терминал рисует её цветными клетками, как и Ghostty и kitty
  внутри tmux. Если ваш терминал умеет показывать картинки, задайте
  `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` до запуска Claude Code, и карточка
  отправит ему саму картинку.

В Linux для чтения картинки нужен ImageMagick (`magick` или `convert`). macOS
и Windows читают её средствами системы, а ImageMagick берут, когда он
установлен.

## quick-peek

Путь в ответе, например `src/main.rs` или `docs/plan.md:42`, становится
ссылкой, если такой файл есть. Наведите указатель и увидите карточку: имя,
размер и когда файл менялся. Для кода и текста в карточке есть первые строки
или строки вокруг той, что названа в пути. Щелчок показывает файл в Finder,
Проводнике или файловом менеджере Linux. Щелчок с Alt открывает его.

## quotaline

```
ctx 34% · 5h 21% ↻ 4h 2m · week 62% ↻ 2d 4h 42m · fable 65% · Opus 5.5 medium
```

Слева направо: заполнение контекста, пятичасовой и недельный лимиты со
временем до сброса каждого, недельный лимит отдельной модели, если он есть в
вашем тарифе, и модель с уровнем усилия. Числа желтеют, а затем краснеют,
когда лимит подходит к концу.

После сброса `5h` и `week` показывают 0%, пока сессия не принесёт новые числа,
но не дольше, чем длится само окно (пять часов или неделя), а затем уходят из
строки. Недельный лимит модели уходит из строки при сбросе и когда запросы к
серверу не удаются больше часа: его сообщает только сервер. Строка
`limits: no data` значит, что Claude Code не передал ничего, что можно
показать, и ни одна сессия ещё не сохранила лимиты.

Все сессии на машине делятся тем, что узнали. Поэтому простаивающая сессия
тоже показывает свежие числа, а новая показывает их ещё до первого ответа.
Сессия с оплатой по ключу API вместо лимитов показывает свой расход и сумму
за день. Обе суммы это оценка Claude Code по прайсу, а не счёт.

## Что читает, что пишет и что отправляет

- `quotaline` читает ключ входа Claude Code (связка ключей macOS или
  `.credentials.json` в папке Claude Code) и отправляет его на
  `api.anthropic.com`, чтобы спросить ваши лимиты. Кроме него ключ может уйти
  только на проверочный сервер на этой машине, который называет переменная
  `QUOTALINE_API`. Спрашивает не чаще раза в пять минут на все сессии и не
  спрашивает вовсе, если не может писать в папку кэша: там сессии отмечают,
  когда спрашивали в последний раз. Ключ не обновляет и не сохраняет. Числа
  хранит в `quotaline/limits.json`, рядом с файлом блокировки, в папке кэша
  (`$XDG_CACHE_HOME` или `~/.cache`, в Windows `%LOCALAPPDATA%`). `--setup`
  меняет в настройках Claude Code один ключ, `statusLine`, и только после
  вашего согласия.
- `image-preview` читает картинки, которые Claude Code сохранил для сессии,
  и пишет рядом уменьшенные копии, во временную папку сессии. Для чтения
  картинки запускает ImageMagick, `sips` или PowerShell, по щелчку программу
  просмотра системы. В Windows и под WSL ещё держит во временной папке Windows
  помощника окна, `image-preview-popup-1.dll`.
- `quick-peek` читает размер, дату и первые строки файлов, названных в
  ответе. По щелчку запускает файловый менеджер.

Плагины ничего не отправляют в сеть. Причину сбоя, который они обходят,
плагины пишут в журнал отладки Claude Code.

## Обновления

Плагины из стороннего набора Claude Code сам не обновляет. Включите
обновление в `/plugin`, раздел Marketplaces, или выполните:

```
claude plugin update image-preview@claude-code-kit
claude plugin update quick-peek@claude-code-kit
```

Чтобы обновить quotaline, скачайте новый выпуск и замените файл.

## Известные ограничения

- Полноэкранный интерфейс в Claude Code пока пробный. Без него плагины не
  мешают и ничего не рисуют.
- В Windows по SSH Claude Code выключает полноэкранный интерфейс. Там нужен
  терминал на самой машине.
- Недельный лимит отдельной модели и числа до первого ответа сессии приходят
  с адреса сервера, которым Claude Code пользуется, но который не описан в
  документации. Если он изменится, строка покажет то, что сообщает сам Claude
  Code.

## Разработка

Смотрите [CONTRIBUTING.md](CONTRIBUTING.md). О проблемах безопасности пишите,
как сказано в [SECURITY.md](SECURITY.md). Сделано с Claude Code.

## Лицензия

[MIT](LICENSE). Плагины выросли из `image-preview` и `quick-peek` проекта
[better-claude](https://github.com/midudev/better-claude), автор Miguel Ángel
Durán, тоже MIT; его уведомление лежит в [plugins/LICENSE](plugins/LICENSE).
