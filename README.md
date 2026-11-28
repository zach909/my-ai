# NeuroClaw

<p align="center"><img src="docs/media/hero.svg" alt="A coral cord turning around a glowing sphere with a small green agent inside" width="420"></p>

<p align="center">A local-first AI agent on your own computer, powered by <b>OneBrain</b>, a neural mesh engine.<br>No account, no cloud, no tokenizer.</p>

> **This is an educational project in beta. Please spread the word.**
> WE ARE NOT RESPONSIBLE FOR YOUR ACTIONS OR WHAT THE CODE DOES. BY CONTINUING YOU AGREE WITH THIS STATEMENT AND THE [PRIVACY POLICY](PRIVACY.md) AND [TERMS AND CONDITIONS](TERMS.md).

## Download

Click a button. Open it like any other app: no terminal, no browser.

<table>
<tr>
<td><b>Linux</b><br><sub>Debian, Ubuntu, Chromebook Linux</sub></td>
<td><a href="https://github.com/zach909/my-ai/releases/latest/download/neuroclaw-linux-x64.deb"><img src="docs/media/btn-linux-deb.svg" alt="Download .deb" width="224"></a></td>
<td><a href="https://github.com/zach909/my-ai/releases/latest/download/neuroclaw-linux-x64.tar.gz"><img src="docs/media/btn-linux-tar.svg" alt="Download .tar.gz" width="224"></a></td>
</tr>
<tr>
<td><b>Windows</b><br><sub>installs for you only</sub></td>
<td><a href="https://github.com/zach909/my-ai/releases/latest/download/neuroclaw-windows-x64.exe"><img src="docs/media/btn-windows-exe.svg" alt="Download .exe" width="224"></a></td>
<td><a href="https://github.com/zach909/my-ai/releases/latest/download/neuroclaw-windows-x64.zip"><img src="docs/media/btn-windows-zip.svg" alt="Download .zip" width="224"></a></td>
</tr>
<tr>
<td><b>macOS</b><br><sub>Apple silicon</sub></td>
<td><a href="https://github.com/zach909/my-ai/releases/latest/download/neuroclaw-macos-arm64.dmg"><img src="docs/media/btn-macos-dmg.svg" alt="Download .dmg" width="224"></a></td>
<td><a href="https://github.com/zach909/my-ai/releases/latest/download/neuroclaw-macos-arm64.zip"><img src="docs/media/btn-macos-zip.svg" alt="Download .zip" width="224"></a></td>
</tr>
<tr>
<td><b>Android</b><br><sub>sideload</sub></td>
<td><a href="https://github.com/zach909/my-ai/releases/latest/download/neuroclaw-android-any.apk"><img src="docs/media/btn-android-apk.svg" alt="Download .apk" width="224"></a></td>
<td></td>
</tr>
<tr>
<td><b>Chrome / Chromebook</b><br><sub>extension</sub></td>
<td><a href="https://github.com/zach909/my-ai/releases/latest/download/neuroclaw-chrome-extension.zip"><img src="docs/media/btn-chrome-zip.svg" alt="Download .zip" width="224"></a></td>
<td></td>
</tr>
</table>

<p>No installer yet? <a href="https://github.com/zach909/my-ai/archive/refs/heads/main.zip"><img src="docs/media/btn-source-zip.svg" alt="Source code .zip" width="224"></a> (the code, to run with <code>npm run app</code>)</p>

iPhone and iPad: not available yet. All platforms and what each can do: [docs/PLATFORMS.md](docs/PLATFORMS.md).

## What it does

Open [`docs/index.html`](docs/index.html) in a browser for the full animated page. Here is the same thing in pictures:

<table>
<tr>
<td><img src="docs/media/mesh.svg" alt="Neural mesh" width="400"></td>
<td><img src="docs/media/experts.svg" alt="Mixture of experts" width="400"></td>
</tr>
<tr>
<td><img src="docs/media/bits.svg" alt="Raw bits, no tokenizer" width="400"></td>
<td><img src="docs/media/learning.svg" alt="Self-improving" width="400"></td>
</tr>
<tr>
<td><img src="docs/media/private.svg" alt="Local-first and private" width="400"></td>
<td><img src="docs/media/extensions.svg" alt="Extensions and skills" width="400"></td>
</tr>
</table>

## Run it from source

```bash
npm run app        # build and open it in its own window
npm run package    # build the installer for your system into release-artifacts/
```

## More

- [What every file and folder does](docs/FILE_GUIDE.md)
- [Features and engine deep-dives](docs/DEEP_DIVES.md): the neural architecture, learning, the core API, training, parallel computing, developer quick start and tests
- [Android standalone](mobile/android-standalone/README.md): runs OneBrain fully on the phone, built from source for now
- [Platforms, install and update](docs/PLATFORMS.md)
- [More documentation](docs/) and the [wiki](wiki/)

## License

See the LICENSE file in subdirectories for specific licensing information.
