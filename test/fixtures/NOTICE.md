# Third-party test fixtures

## `transcript-real-session.jsonl`

A transcript captured from a real Cursor session on 2026-08-24, taken from the
[`entireio/cli`](https://github.com/entireio/cli) repository
(`cmd/entire/cli/agent/cursor/testdata/real_session_tool_use.jsonl`), which
pins it as a regression fixture for the same file format.

It is used here to prove the transcript reader against a genuine Cursor file
rather than one we wrote ourselves.

Licensed under the MIT License, Copyright (c) 2026 Entire Inc.

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

Replaceable: once a transcript from one of our own Cursor sessions is captured
and redacted, swap it in and delete this notice.
