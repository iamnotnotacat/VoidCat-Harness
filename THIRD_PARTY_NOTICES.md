# Third-party runtime notices

VoidCat Harness packages the official Windows x64 `whisper.cpp` command-line runtime and the quantized `tiny.en` model for local speech recognition. Both are downloaded from their official project locations during Windows packaging, verified against pinned checksums, and remain entirely local at runtime.

- `whisper.cpp` — <https://github.com/ggml-org/whisper.cpp> — MIT License
- Converted Whisper model — <https://huggingface.co/ggerganov/whisper.cpp> — MIT License

Windows text-to-speech uses the operating system's installed `System.Speech` voices and does not contact a cloud service.
