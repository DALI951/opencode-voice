// sox.exe wrapper: records microphone for opencode-voice plugin.
// Plugin calls:  sox -d -r 16000 -c 1 -b 16 C:\tmp\opencode-stt.wav [silence ...]
// Uses winmm waveIn (native MME) + software resample/downmix.
// The process is typically TerminateProcess'd by the plugin on stop, so the
// WAV header is patched with real sizes every ~500ms while recording; a file
// killed between patches still decodes (header pre-filled with big sizes).
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class SoxWrapper
{
    [DllImport("winmm.dll")] static extern uint waveInOpen(out IntPtr h, IntPtr dev, ref WAVEFORMATEX fmt, IntPtr cb, IntPtr inst, uint flags);
    [DllImport("winmm.dll")] static extern uint waveInClose(IntPtr h);
    [DllImport("winmm.dll")] static extern uint waveInPrepareHeader(IntPtr h, ref WAVEHDR hdr, uint size);
    [DllImport("winmm.dll")] static extern uint waveInAddBuffer(IntPtr h, ref WAVEHDR hdr, uint size);
    [DllImport("winmm.dll")] static extern uint waveInUnprepareHeader(IntPtr h, ref WAVEHDR hdr, uint size);
    [DllImport("winmm.dll")] static extern uint waveInStart(IntPtr h);
    [DllImport("winmm.dll")] static extern uint waveInStop(IntPtr h);
    [DllImport("winmm.dll")] static extern uint waveInGetNumDevs();

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX { public ushort wFormatTag, nChannels; public uint nSamplesPerSec, nAvgBytesPerSec; public ushort nBlockAlign, wBitsPerSample, cbSize; }

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEHDR { public IntPtr lpData; public uint dwBufferLength, dwBytesRecorded; public IntPtr dwUser; public uint dwFlags, dwLoops; public IntPtr lpNext, reserved; }

    const uint WHDR_DONE = 0x1;
    const uint WAVE_MAPPER = 0xFFFFFFFF;

    static int Main(string[] args)
    {
        foreach (string a in args)
        {
            if (a == "--version") { Console.WriteLine("sox Wrapper v1 (winmm waveIn)"); return 0; }
            if (a == "-h" || a == "--help") { Console.WriteLine("sox wrapper: record mic to WAV. sox -d -r R -c C -b B out.wav [trim 0 SECS]"); return 0; }
        }
        int reqRate = 16000, reqBits = 16, reqCh = 1;
        string outFile = null;
        bool isDefault = false;
        double trimSecs = 0;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "-d": isDefault = true; break;
                case "-r": if (i + 1 < args.Length) int.TryParse(args[++i], out reqRate); break;
                case "-b": if (i + 1 < args.Length) int.TryParse(args[++i], out reqBits); break;
                case "-c": if (i + 1 < args.Length) int.TryParse(args[++i], out reqCh); break;
                case "-q": break;
                case "trim":
                    if (i + 2 < args.Length) { double ignored; if (double.TryParse(args[i + 1], out ignored)) { double d2; if (double.TryParse(args[i + 2], out d2)) trimSecs = d2; } i += 2; }
                    break;
                case "silence": case "1": case "0.1": case "1%": break;
                default:
                    if (!args[i].StartsWith("-") && outFile == null) outFile = args[i];
                    break;
            }
        }
        if (!isDefault || outFile == null) { Console.Error.WriteLine("sox: unsupported invocation"); return 1; }

        // candidate input formats: requested first, then common supported ones
        int[] ratesS = { reqRate, 48000, 44100, 16000 };
        int[] chansS = { reqCh, reqCh, 2, 1 };

        IntPtr h = IntPtr.Zero;
        WAVEFORMATEX fmt = new WAVEFORMATEX();
        int devCount = (int)waveInGetNumDevs();
        uint rc = 1; IntPtr dev = new IntPtr(-1);
        for (int fi = 0; fi < ratesS.Length && rc != 0; fi++)
        {
            int rate = ratesS[fi], chans = chansS[fi] == 0 ? 1 : chansS[fi];
            ushort block = (ushort)((reqBits / 8) * chans);
            fmt.wFormatTag = 1; fmt.nChannels = (ushort)chans; fmt.nSamplesPerSec = (uint)rate;
            fmt.nAvgBytesPerSec = (uint)(rate * block); fmt.nBlockAlign = block;
            fmt.wBitsPerSample = (ushort)reqBits; fmt.cbSize = 0;
            // try mapper then each device
            rc = waveInOpen(out h, new IntPtr(-1), ref fmt, IntPtr.Zero, IntPtr.Zero, 0);
            dev = new IntPtr(-1);
            if (rc != 0)
            {
                for (int d = 0; d < devCount; d++)
                {
                    rc = waveInOpen(out h, new IntPtr(d), ref fmt, IntPtr.Zero, IntPtr.Zero, 0);
                    if (rc == 0) { dev = new IntPtr(d); break; }
                }
            }
            if (rc == 0) { fmt.nSamplesPerSec = (uint)rate; fmt.nChannels = (ushort)chans; fmt.nAvgBytesPerSec = (uint)(rate * block); fmt.nBlockAlign = block; }
        }
        int inRate = (int)fmt.nSamplesPerSec, inCh = fmt.nChannels;
        if (rc != 0) { Console.Error.WriteLine("sox: no input device available"); return 1; }

        // open output file, header with big placeholder sizes
        try { File.Delete(outFile); } catch { }
        FileStream fs = new FileStream(outFile, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read);
        byte[] hdr = new byte[44];
        WriteWavHeaderPre(fs, hdr, reqRate, reqBits, reqCh);

        const int BUF = 8192;
        int depth = 8;
        WAVEHDR[] hdrs = new WAVEHDR[depth];
        byte[][] datas = new byte[depth][];
        GCHandle[] pins = new GCHandle[depth];
        for (int i = 0; i < depth; i++)
        {
            datas[i] = new byte[BUF];
            pins[i] = GCHandle.Alloc(datas[i], GCHandleType.Pinned);
            hdrs[i] = new WAVEHDR();
            hdrs[i].lpData = pins[i].AddrOfPinnedObject();
            hdrs[i].dwBufferLength = BUF;
            hdrs[i].dwUser = (IntPtr)0;
        }
        for (int i = 0; i < depth; i++)
        {
            waveInPrepareHeader(h, ref hdrs[i], (uint)Marshal.SizeOf(typeof(WAVEHDR)));
            waveInAddBuffer(h, ref hdrs[i], (uint)Marshal.SizeOf(typeof(WAVEHDR)));
        }
        waveInStart(h);

        int idx = 0, totalSamples = 0; long bytesWritten = 0;
        byte[] conv = new byte[BUF * 2];
        byte[] tmp = new byte[BUF * 2];
        DateTime lastPatch = DateTime.UtcNow;
        DateTime startedAt = DateTime.UtcNow;

        try
        {
            while (true)
            {
                if (trimSecs > 0 && (DateTime.UtcNow - startedAt).TotalSeconds >= trimSecs)
                {
                    PatchWavSizes(fs, (int)bytesWritten + 44, 44);
                    fs.Flush();
                    break;
                }
                int slot = idx % depth;
                bool progressed = false;
                for (int k = 0; k < depth; k++)
                {
                    int s = (idx + k) % depth;
                    if ((hdrs[s].dwFlags & WHDR_DONE) != 0)
                    {
                        uint got = hdrs[s].dwBytesRecorded;
                        if (got > 0 && got <= BUF)
                        {
                            Array.Copy(datas[s], conv, got);
                            int nBytes = ConvertPcm(conv, (int)got, inRate, inCh, reqRate, reqCh, reqBits, tmp);
                            fs.Write(tmp, 0, nBytes);
                            bytesWritten += nBytes;
                            totalSamples += nBytes / 2;
                        }
                        // re-arm
                        hdrs[s].dwBytesRecorded = 0; hdrs[s].dwFlags &= ~WHDR_DONE;
                        waveInAddBuffer(h, ref hdrs[s], (uint)Marshal.SizeOf(typeof(WAVEHDR)));
                        idx++; progressed = true;
                    }
                }
                // patch header sizes periodically
                if (DateTime.UtcNow - lastPatch > TimeSpan.FromMilliseconds(500))
                {
                    PatchWavSizes(fs, (int)bytesWritten + 44, 44);
                    lastPatch = DateTime.UtcNow;
                }
                if (!progressed) Thread.Sleep(15);
            }
        }
        catch { } // killed / file closed - header already patched recently
        return 0;
    }

    static int ConvertPcm(byte[] inBuf, int len, int inRate, int inCh, int outRate, int outCh, int outBits, byte[] outBuf)
    {
        int inSamples = len / (2 * inCh);
        int outSamples = (int)((long)inSamples * outRate / inRate);
        for (int o = 0; o < outSamples; o++)
        {
            double srcPos = (double)o * inRate / outRate; // sample position in input
            int i0 = (int)srcPos;
            if (i0 >= inSamples) i0 = inSamples - 1;
            int i1 = i0 + 1 < inSamples ? i0 + 1 : i0;
            double frac = srcPos - i0;
            int s0 = PcmAt(inBuf, i0, inCh);
            int s1 = PcmAt(inBuf, i1, inCh);
            int s = (int)(s0 + (s1 - s0) * frac);
            if (outCh == 1)
            {
                outBuf[o * 2] = (byte)(s & 0xFF);
                outBuf[o * 2 + 1] = (byte)((s >> 8) & 0xFF);
            }
            else
            {
                outBuf[o * 4] = (byte)(s & 0xFF);
                outBuf[o * 4 + 1] = (byte)((s >> 8) & 0xFF);
                outBuf[o * 4 + 2] = (byte)(s & 0xFF);
                outBuf[o * 4 + 3] = (byte)((s >> 8) & 0xFF);
            }
        }
        return outSamples * 2 * outCh;
    }

    static int PcmAt(byte[] b, int i, int ch)
    {
        int s = 0;
        if (ch >= 2 && i * 2 * 2 + 2 < b.Length) s = b[i * 4] | (b[i * 4 + 1] << 8);
        else if (i * 2 + 2 <= b.Length) s = b[i * 2] | (b[i * 2 + 1] << 8);
        return (short)s;
    }

    static void WriteWavHeaderPre(FileStream fs, byte[] h, int rate, int bits, int ch)
    {
        byte[] b = h;
        for (int i = 0; i < 44; i++) b[i] = 0;
        System.Text.Encoding.ASCII.GetBytes("RIFF").CopyTo(b, 0);
        System.Text.Encoding.ASCII.GetBytes("WAVE").CopyTo(b, 8);
        System.Text.Encoding.ASCII.GetBytes("fmt ").CopyTo(b, 12);
        WriteLE32(b, 16, 16); WriteLE16(b, 20, 1); WriteLE16(b, 22, (ushort)ch);
        WriteLE32(b, 24, (uint)rate); WriteLE32(b, 28, (uint)(rate * ch * (bits / 8)));
        WriteLE16(b, 32, (ushort)(ch * (bits / 8))); WriteLE16(b, 34, (ushort)bits);
        System.Text.Encoding.ASCII.GetBytes("data").CopyTo(b, 36);
        WriteLE32(b, 40, 0xFFFFFFFF); // big placeholder - patched while recording
        fs.Write(b, 0, 44);
    }

    static void PatchWavSizes(FileStream fs, int riffSize, int dataOffset)
    {
        try
        {
            long pos = fs.Position;
            fs.Seek(4, SeekOrigin.Begin);
            byte[] sb = new byte[4];
            WriteLE32(sb, 0, (uint)riffSize);
            fs.Write(sb, 0, 4);
            fs.Seek(dataOffset, SeekOrigin.Begin);
            fs.Write(sb, 0, 4);
            fs.Seek(pos, SeekOrigin.Begin);
            fs.Flush();
        }
        catch { }
    }

    static void WriteLE16(byte[] b, int o, ushort v) { b[o] = (byte)(v & 0xFF); b[o + 1] = (byte)((v >> 8) & 0xFF); }
    static void WriteLE32(byte[] b, int o, uint v) { b[o] = (byte)(v & 0xFF); b[o + 1] = (byte)((v >> 8) & 0xFF); b[o + 2] = (byte)((v >> 16) & 0xFF); b[o + 3] = (byte)((v >> 24) & 0xFF); }
}