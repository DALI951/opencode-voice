// play.exe wrapper: speaks what the opencode-voice plugin pipes to "play"
// Supports:  play -t raw -r RATE -e signed -b BITS -c CH -q -   (stdin pipe)
//            play somefile.wav                                  (wav file)
// Uses winmm waveOut (native MME). Keeps the queue full and waits by duration.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class PlayWrapper
{
    [DllImport("winmm.dll")] static extern uint waveOutOpen(out IntPtr h, IntPtr dev, ref WAVEFORMATEX fmt, IntPtr cb, IntPtr inst, uint flags);
    [DllImport("winmm.dll")] static extern uint waveOutClose(IntPtr h);
    [DllImport("winmm.dll")] static extern uint waveOutPrepareHeader(IntPtr h, IntPtr hdr, uint size);
    [DllImport("winmm.dll")] static extern uint waveOutWrite(IntPtr h, IntPtr hdr, uint size);
    [DllImport("winmm.dll")] static extern uint waveOutGetNumDevs();
    [DllImport("winmm.dll")] static extern uint waveOutGetPosition(IntPtr h, ref MMTIME mmt, uint size);

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX { public ushort wFormatTag, nChannels; public uint nSamplesPerSec, nAvgBytesPerSec; public ushort nBlockAlign, wBitsPerSample, cbSize; }

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEHDR { public IntPtr lpData; public uint dwBufferLength, dwBytesRecorded; public IntPtr dwUser; public uint dwFlags, dwLoops; public IntPtr lpNext, reserved; }

    [StructLayout(LayoutKind.Sequential)]
    struct MMTIME { public uint wType; public uint u; public long dummy; } // 16 bytes: matches x64 MMTIME (union holds a pointer)

    static int Main(string[] args)
    {
        int rate = 22050, bits = 16, ch = 1;
        bool raw = false;
        string file = null;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "-t": if (i + 1 < args.Length && args[i + 1] == "raw") raw = true; i++; break;
                case "-r": if (i + 1 < args.Length) int.TryParse(args[++i], out rate); break;
                case "-b": if (i + 1 < args.Length) int.TryParse(args[++i], out bits); break;
                case "-c": if (i + 1 < args.Length) int.TryParse(args[++i], out ch); break;
                case "-e": i++; break;
                case "-q": break;
                case "-": file = "-"; break;
                default:
                    if (!args[i].StartsWith("-")) file = args[i];
                    break;
            }
        }
        if (file == null) { Console.Error.WriteLine("play: no input"); return 1; }

        Stream src = null;
        bool isStdIn = file == "-";
        try
        {
            src = isStdIn ? Console.OpenStandardInput() : File.OpenRead(file);
            if (!isStdIn && !raw)
            {
                var hdr = ReadWavHeader(src);
                rate = (int)hdr.Item1; bits = hdr.Item2; ch = hdr.Item3;
            }

            ushort blockAlign = (ushort)((bits / 8) * ch);
            WAVEFORMATEX fmt = new WAVEFORMATEX();
            fmt.wFormatTag = 1; fmt.nChannels = (ushort)ch; fmt.nSamplesPerSec = (uint)rate;
            fmt.nAvgBytesPerSec = (uint)(rate * blockAlign); fmt.nBlockAlign = blockAlign;
            fmt.wBitsPerSample = (ushort)bits; fmt.cbSize = 0;

            IntPtr h = IntPtr.Zero;
            IntPtr dev = new IntPtr(-1);
            uint rc = waveOutOpen(out h, dev, ref fmt, IntPtr.Zero, IntPtr.Zero, 0);
            if (rc != 0)
            {
                int devCount = (int)waveOutGetNumDevs();
                dev = IntPtr.Zero; rc = 1;
                for (int d = 0; d < devCount; d++)
                {
                    rc = waveOutOpen(out h, new IntPtr(d), ref fmt, IntPtr.Zero, IntPtr.Zero, 0);
                    if (rc == 0) { dev = new IntPtr(d); break; }
                }
                if (rc != 0) { Console.Error.WriteLine("play: no output device for " + rate + "/" + bits + "/" + ch); return 1; }
            }

            // Pinned buffers; WAVEHDR structs also pinned in unmanaged memory so the
            // driver can update them. Queue stays full, then wait by duration.
            const int BUF = 32768;
            int depth = 10;
            IntPtr[] unmanagedHdrs = new IntPtr[depth];
            byte[][] datas = new byte[depth][];
            GCHandle[] pins = new GCHandle[depth];
            int hdrSize = Marshal.SizeOf(typeof(WAVEHDR));
            for (int i = 0; i < depth; i++)
            {
                datas[i] = new byte[BUF];
                pins[i] = GCHandle.Alloc(datas[i], GCHandleType.Pinned);
                unmanagedHdrs[i] = Marshal.AllocHGlobal(hdrSize);
                var hdr = new WAVEHDR { lpData = pins[i].AddrOfPinnedObject(), dwBufferLength = BUF };
                Marshal.StructureToPtr(hdr, unmanagedHdrs[i], false);
            }

            uint bytesPerSec = (uint)(rate * blockAlign);
            ulong totalBytes = 0;
            int slot = 0, outstanding = 0;
            bool eof = false;
            byte[] chunk = new byte[BUF];

            while (true)
            {
                while (outstanding < depth && !eof)
                {
                    int n = src.Read(chunk, 0, BUF);
                    if (n == 0) { eof = true; break; }
                    int s = slot % depth;
                    Buffer.BlockCopy(chunk, 0, datas[s], 0, n);
                    var hdr = new WAVEHDR { lpData = pins[s].AddrOfPinnedObject(), dwBufferLength = (uint)n };
                    Marshal.StructureToPtr(hdr, unmanagedHdrs[s], true);
                    uint prc = waveOutPrepareHeader(h, unmanagedHdrs[s], (uint)hdrSize);
                    if (prc != 0) { Console.Error.WriteLine("play: prepare rc=" + prc); break; }
                    waveOutWrite(h, unmanagedHdrs[s], (uint)hdrSize);
                    totalBytes += (uint)n; outstanding++; slot++;
                }
                if (eof) break;
                Thread.Sleep(30);
            }

            // Wait for playback to ACTUALLY finish by polling the device
            // position (TIME_SAMPLES). Removes the old fixed +1.5s margin —
            // short clips no longer linger.
            if (totalBytes > 0 && bytesPerSec > 0)
            {
                double secs = (double)totalBytes / bytesPerSec;
                var deadline = DateTime.UtcNow.AddMilliseconds(secs * 1000 + 2000);
                bool waitedByTime = false;
                while (DateTime.UtcNow < deadline)
                {
                    MMTIME mmt = new MMTIME();
                    mmt.wType = 3; // TIME_SAMPLES
                    if (waveOutGetPosition(h, ref mmt, (uint)Marshal.SizeOf(mmt)) == 0 && mmt.wType == 3)
                    {
                        long played = (long)mmt.u * blockAlign;
                        if (played >= (long)totalBytes) break;
                    }
                    else
                    {
                        waitedByTime = true; // driver can't report samples
                        break;
                    }
                    Thread.Sleep(25);
                }
                if (waitedByTime)
                {
                    // fallback: duration-based wait with a small margin
                    Thread.Sleep(Math.Max(0, (int)(secs * 1000) - 250));
                }
            }
            waveOutClose(h);
            Console.Error.WriteLine("play: done " + (totalBytes / 2) + " samples");
            return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine("play: " + ex.Message); return 1; }
        finally { if (src != null && !isStdIn) src.Dispose(); }
    }

    static Tuple<long, int, int> ReadWavHeader(Stream s)
    {
        byte[] b = new byte[44];
        if (s.Read(b, 0, 44) < 44) throw new Exception("bad wav");
        if (System.Text.Encoding.ASCII.GetString(b, 0, 4) != "RIFF" || System.Text.Encoding.ASCII.GetString(b, 8, 4) != "WAVE")
            throw new Exception("not a RIFF wave file");
        int bits = BitConverter.ToUInt16(b, 34);
        int ch = BitConverter.ToUInt16(b, 22);
        int rate = (int)BitConverter.ToUInt32(b, 24);
        return Tuple.Create((long)rate, bits, ch);
    }
}