[English](README.md) | **Русский**

# claude-code-kit

[![CI](https://github.com/profax/claude-code-kit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/profax/claude-code-kit/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/profax/claude-code-kit)](https://github.com/profax/claude-code-kit/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Три дополнения к Claude Code в терминале: посмотреть вставленную картинку до
отправки, заглянуть в файл, который назван в ответе, и держать лимиты в
строке состояния.

| Часть | Что делает |
|---|---|
| [image-preview](#image-preview) | Наведите указатель на `[Image #N]` и увидите картинку |
| [quick-peek](#quick-peek) | Пути в ответах становятся ссылками с карточкой файла |
| [quotaline](#quotaline) | Строка состояния: контекст, лимиты, время до их сброса |

Все три части работают в macOS, Linux, Windows и WSL. Плагины откликаются на
наведение указателя, поэтому им нужны полноэкранный интерфейс Claude Code,
который включает команда `/tui fullscreen`, и терминал, который передаёт
программам движение мыши. quotaline работает в любом терминале.

Части не зависят друг от друга. Ставьте те, что нужны.

## Установка

### Установка плагинов

Нужен Claude Code 2.1.325 или новее. В Linux плагину image-preview нужен ещё
ImageMagick.

```
/plugin marketplace add profax/claude-code-kit
/plugin install image-preview@claude-code-kit
/plugin install quick-peek@claude-code-kit
```

Затем один раз выполните `/tui fullscreen`: Claude Code получает от терминала
указатель мыши только в полноэкранном интерфейсе, и эта настройка
сохраняется.

В tmux 3.7b наведение работает с настройками tmux по умолчанию. Если в вашем
tmux оно ничего не делает, попробуйте добавить строку `set -g mouse on` в
`~/.tmux.conf` и выполнить `tmux source-file ~/.tmux.conf`.

### Установка quotaline

1. Скачайте со страницы
   [Releases](https://github.com/profax/claude-code-kit/releases) архив для
   своей системы и процессора:

   | Система | Процессор | Архив |
   |---|---|---|
   | macOS | Apple silicon (M1 и новее) | `quotaline-<version>-aarch64-apple-darwin.tar.gz` |
   | macOS | Intel | `quotaline-<version>-x86_64-apple-darwin.tar.gz` |
   | Linux, WSL | x86-64 (Intel или AMD) | `quotaline-<version>-x86_64-unknown-linux-musl.tar.gz` |
   | Linux, WSL | Arm | `quotaline-<version>-aarch64-unknown-linux-musl.tar.gz` |
   | Windows | x86-64 (Intel или AMD) | `quotaline-<version>-x86_64-pc-windows-msvc.zip` |

   На Маке в меню Apple > «Об этом Mac» указан либо чип (Apple silicon,
   например Apple M1), либо процессор (Intel). В Linux и WSL команда
   `uname -m` печатает `x86_64` или `aarch64`.

2. Распакуйте архив и положите программу в папку для программ.

   В macOS, Linux и WSL выполните в терминале:

   ```
   cd ~/Downloads
   tar -xzf quotaline-*.tar.gz
   mkdir -p ~/.local/bin
   mv quotaline-*/quotaline ~/.local/bin/
   ```

   Если браузер уже распаковал архив, пропустите строку с `tar`. Под WSL
   браузер из Windows сохраняет файлы в папку «Загрузки» Windows, поэтому
   начните вместо этого с `cd /mnt/c/Users/you/Downloads`, подставив вместо
   `you` своё имя пользователя Windows.

   В Windows щёлкните архив правой кнопкой в Проводнике и выберите «Извлечь
   все». Создайте папку для программ, в пути к которой нет пробелов, например
   `C:\Users\you\bin` (если в имени пользователя есть пробел, `C:\tools`), и
   перенесите туда `quotaline.exe` из распакованной папки.

3. Запустите программу по полному пути с `--setup`:

   ```
   ~/.local/bin/quotaline --setup
   ```

   В Windows выполните в PowerShell `C:\Users\you\bin\quotaline.exe --setup`.
   Папке не обязательно быть в `PATH`: `--setup` записывает в настройки
   полный путь. Без аргументов `quotaline` печатает справку.

   Программу, скачанную браузером, macOS не запускает, пока её не проверила
   Apple, а quotaline Apple не проверяла. Если macOS сообщит, что не может
   проверить `quotaline`, и не запустит её, снимите с файла пометку, которую
   поставила macOS, и повторите шаг 3:

   ```
   xattr -d com.apple.quarantine ~/.local/bin/quotaline
   ```

`--setup` покажет, что собирается изменить в настройках Claude Code, спросит
согласия и сохранит копию прежнего файла:

```
$ ~/.local/bin/quotaline --setup
quotaline will add this to /Users/you/.claude/settings.json:

  "statusLine": {
    "type": "command",
    "command": "/Users/you/.local/bin/quotaline",
    "refreshInterval": 60
  }

Write it? [y/N] y
Added the status line to /Users/you/.claude/settings.json.
The previous file is saved as /Users/you/.claude/settings.json.20261201T101500Z.bak
Claude Code reloads its settings on its own: open sessions show the line without a restart.
```

Если в настройках строкой состояния уже названа другая программа, quotaline
её не тронет и напечатает, что поменять вручную.

Вместо шагов 1 и 2 quotaline можно собрать из исходного кода (нужен Rust 1.89
или новее):

```
cargo install --locked --git https://github.com/profax/claude-code-kit quotaline
```

Программа окажется в `~/.cargo/bin`, поэтому на шаге 3 выполните
`~/.cargo/bin/quotaline --setup` (в Windows `quotaline.exe`).

<details>
<summary>Настройка вручную</summary>

Добавьте это в `~/.claude/settings.json`, с полным путём к программе. В
Windows путь пишется с косой чертой `/`, например
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

Как показывается картинка, зависит от терминала:

- Ghostty и kitty рисуют картинку сами.
- Другие терминалы показывают её цветными клетками, как и Ghostty и kitty
  внутри tmux: tmux не пропускает картинки. Если ваш терминал умеет
  показывать картинки, задайте `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` до
  запуска Claude Code, и карточка отправит ему саму картинку.

В Windows и под WSL вместо цветных клеток картинка открывается в окне у
указателя, в tmux тоже. Окно не забирает фокус и закрывается, когда указатель
уходит. По SSH окна нет, и остаются клетки.

В Linux для чтения картинки нужен ImageMagick (`magick` или `convert`). macOS,
Windows и WSL читают её средствами системы, а ImageMagick берут, когда он
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
вашем тарифе, и модель с уровнем усилия, а также `fast`, пока включён
быстрый режим. Числа желтеют, а затем краснеют, когда лимит подходит к концу.

После сброса `5h` и `week` показывают 0%, пока сессия не принесёт новые числа,
но не дольше, чем длится само окно (пять часов или неделя), а затем уходят из
строки. Недельный лимит модели уходит из строки при сбросе и когда запросы к
серверу не удаются больше часа: его сообщает только сервер. Строка
`limits: no data` значит, что Claude Code не передал ничего, что можно
показать, и ни одна сессия ещё не сохранила лимиты.

Все сессии на машине делятся тем, что узнали. Поэтому простаивающая сессия
тоже показывает свежие числа, а новая показывает их ещё до первого ответа.

Сессия с оплатой по ключу API показывает свой расход, а рядом сумму за день
по всем таким сессиям на машине, например `$0.50 · today $1.74`. Пока сумма
за день равна расходу самой сессии, её в строке нет. Обе суммы это оценка
Claude Code по опубликованным ценам, а не счёт. Если на машине есть ещё и
вход по подписке, строка показывает и лимиты этой подписки.

## Что читает, что пишет и что отправляет

- `quotaline` читает токен входа Claude Code (связка ключей macOS или
  `.credentials.json` в папке Claude Code) и отправляет его на
  `api.anthropic.com`, чтобы спросить ваши лимиты. Кроме него токен может уйти
  только на проверочный сервер на этой машине, который называет переменная
  `QUOTALINE_API`. Спрашивает не чаще раза в пять минут на все сессии и не
  спрашивает вовсе, если не может писать в папку кэша: там сессии отмечают,
  когда спрашивали в последний раз. Токен не обновляет и не сохраняет. Числа
  хранит в `quotaline/limits.json`, рядом с файлом блокировки, в папке кэша
  (`$XDG_CACHE_HOME` или `~/.cache`, в Windows `%LOCALAPPDATA%`). `--setup`
  меняет в настройках Claude Code одно поле, `statusLine`, и только после
  вашего согласия.
- `image-preview` читает картинки, которые Claude Code сохранил для сессии,
  и пишет рядом копии другого размера, во временную папку сессии. Для чтения
  картинки запускает ImageMagick, `sips` или PowerShell, по щелчку программу
  просмотра системы. В Windows и под WSL ещё держит во временной папке Windows
  вспомогательный файл окна с картинкой, `image-preview-popup-1.dll`.
- `quick-peek` читает размер, дату и показанные в карточке строки файлов,
  названных в ответе. По щелчку запускает файловый менеджер. По щелчку с Alt
  открывает файл программой, назначенной для него в системе: если файл сам
  программа, он запустится.

Плагины ничего не отправляют в сеть. Если плагин не может выполнить часть
своей работы (quick-peek не может разобрать ответ, image-preview не может
прочитать поле ввода или открыть окно), он обходится без неё и пишет причину
в журнал отладки Claude Code, который включает `claude --debug`. Если
картинку не удалось прочитать, причина видна в её карточке. Щелчок, который
не смог запустить программу просмотра или файловый менеджер, ничего не
делает.

## Обновления

Плагины из стороннего набора (marketplace) Claude Code сам не обновляет.
Включите обновление в `/plugin`, на вкладке Marketplaces, или выполните эти
команды в терминале, вне Claude Code, а затем перезапустите Claude Code:

```
claude plugin update image-preview@claude-code-kit
claude plugin update quick-peek@claude-code-kit
```

Чтобы обновить quotaline, повторите шаги 1 и 2 из раздела
[Установка quotaline](#установка-quotaline) с новым выпуском. Настройки уже
указывают на этот файл, поэтому шаг 3 не нужен; в macOS снова выполните
команду `xattr` из него.

## Известные ограничения

- Полноэкранный интерфейс в Claude Code пока пробный. Без него плагины не
  мешают и ничего не рисуют.
- В Windows по SSH Claude Code выключает полноэкранный интерфейс. Там нужен
  терминал на самой машине.
- quick-peek делает ссылками пути в абзацах и списках ответа. Путь в таблице,
  заголовке, цитате или блоке кода остаётся обычным текстом.
- Недельный лимит отдельной модели и числа до первого ответа сессии приходят
  с адреса сервера, которым Claude Code пользуется, но который не описан в
  документации. Если он изменится, строка покажет то, что сообщает сам Claude
  Code.
- В macOS Claude Code хранит вход профиля, заданного через
  `CLAUDE_CONFIG_DIR`, в связке ключей под именем, которое quotaline не ищет.
  В таком профиле quotaline читает только `.credentials.json` в этой папке.
  Без этого файла строка не получает чисел с сервера: ни недельного лимита
  отдельной модели, ни лимитов до первого ответа сессии.

## Разработка

Смотрите [CONTRIBUTING.md](CONTRIBUTING.md). О проблемах безопасности пишите,
как сказано в [SECURITY.md](SECURITY.md). Сделано с Claude Code.

## Лицензия

[MIT](LICENSE). Плагины выросли из `image-preview` и `quick-peek` проекта
[better-claude](https://github.com/midudev/better-claude), автор Miguel Ángel
Durán, тоже MIT; текст его лицензии с именем автора лежит в
[plugins/LICENSE](plugins/LICENSE).
