# FAQ

## Do players need to install an app?

No. Phones join in the browser by scanning the QR code on the TV, or by opening the controller URL and typing the 4-letter code. Only the TV needs the Cadabra APK.

## How many players can play?

One to four. Bots fill the empty seats, so one phone is enough, and the built-in games run with no phones at all.

## Which Fire TV devices does it run on?

It was built and measured on a Fire TV Stick HD (Fire OS 7.7, 922 MB RAM), the cheapest stick, at about 59 fps in every built-in game. Faster Fire TV devices have more headroom.

## How long does it take to make a game?

The Idea Storm lasts 30 s. Three pitches arrive about 6 s later. After the vote, the winning game is ready in about 4 to 7 s, already played once by bots.

## What if the AI is slow or down?

The room never waits. Every AI step has a deadline and a fallback that is already good: fallback pitches after 8 s, a reskinned built-in game if the winner isn't ready 25 s after the vote, and tested tweak presets if a tweak takes more than about 12 s. The TV also has its own presets for offline play.

## Does the AI write code?

No. It composes a `GameSpec` from 9 tested blocks with tool calls. The engine runs the spec, and bots must finish a full round with it before it reaches the TV. See [AI designer and Tweak loop](ai-designer.html).

## Is it safe for kids?

Family-safe mode is on by default. Amazon Bedrock Guardrails screens every idea, typed tweak, pitch, tweak summary, caption and roast, and screening fails closed. Blocked ideas are dropped, and the player's phone shows a "blocked" screen.

## What happens to selfie avatars?

A selfie is styled on the phone and sent only to the TV. Other phones get a reference to it, never the image.

## Which models does it use?

Claude Sonnet 5.5 designs and tweaks games. Claude Haiku 5.5 writes pitches and host captions. Calls go to Amazon Bedrock first and fall back to the Anthropic API when Bedrock has no quota, then move back to Bedrock on their own.

## Why is there no host voice?

A host voice on Amazon Polly was built, then turned off by choice. The host speaks in on-screen captions, and the end-of-round roast is written from the real event log.

## Why is the art procedural?

The image model quota on the hackathon account was 0 and could not be raised, so all four looks (neon, toybox, cosmos, retro) are drawn in code, with their own particles, music and sfx. It also means any look can restyle any game.

## Can I use the phone controller in my own game?

Yes. The transport and widgets are published as [couchpad](https://github.com/MaanavKrishna/couchpad) under the MIT licence: QR join, a WebRTC DataChannel with a WebSocket relay fallback, and joystick, button, tilt, swipe, draw and vote widgets.

## What licence is Cadabra under?

MIT. The Figtree font is under the SIL Open Font License.
