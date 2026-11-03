# Third-party notices

This project's own code is MIT-licensed (see `LICENSE`). It includes or loads the following third-party material.

## Included in the repository

**Three.js** (`three.min.js`, r128), used to draw the 3D device.
Copyright 2010-2021 Three.js Authors. MIT License (SPDX: MIT).
Source: https://github.com/mrdoob/three.js

```
The MIT License

Copyright © 2010-2021 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Loaded at run time (not stored in the repository)

The pages load these two fonts from Google Fonts. Both are licensed under the SIL Open Font License 1.1.

- **Inter**, by Rasmus Andersson. https://github.com/rsms/inter
- **Press Start 2P**, by CodeMan38. https://fonts.google.com/specimen/Press+Start+2P

Offline, the pages fall back to system fonts.

## Not included

- **No Game Boy ROMs, boot ROMs or BIOS images** are in this repository or needed by it. Games are loaded by the user, from files they own, and stay in their own browser.
- The emulator in `game/gb/` is original code written from publicly documented hardware behaviour. It contains no code from Nintendo or from any other emulator.
- The CPU was checked against Blargg's `cpu_instrs` test ROMs. Those ROMs are not part of this repository.
