// Original, bounded, read-only helper. No injection, process writes, privilege
// adjustment, dump files or automatic elevation. Candidate records must be
// authenticated against the chosen DBs. The separate fixed-profile mode emits
// one storage-key record consumed only in the application's private pipe.
// .NET Framework / C# 5 / AnyCPU (requires a 64-bit runtime).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

internal static class KeyReader
{
    private const uint ProcessQueryAndRead = 0x0410;
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint TokenQuery = 0x0008;
    private const uint MemCommit = 0x1000;
    private const uint MemPrivate = 0x20000;
    private const int ChunkBytes = 4 * 1024 * 1024;
    private const int OverlapBytes = 256;
    private const int InputLimit = 64 * 1024;
    private const int CandidateLimit = 512;
    private const ulong ByteLimit = 8UL * 1024 * 1024 * 1024;
    private const int TimeLimitSeconds = 60;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = InputLimit, RecursionLimit = 8 };
    private static readonly StreamWriter Output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
    private static bool OutputClosed;

    [StructLayout(LayoutKind.Explicit, Size = 48)]
    private struct MemoryInfo64
    {
        [FieldOffset(0)] public ulong BaseAddress;
        [FieldOffset(8)] public ulong AllocationBase;
        [FieldOffset(16)] public uint AllocationProtect;
        [FieldOffset(24)] public ulong RegionSize;
        [FieldOffset(32)] public uint State;
        [FieldOffset(36)] public uint Protect;
        [FieldOffset(40)] public uint Type;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SystemInfo
    {
        public ushort Architecture;
        public ushort Reserved;
        public uint PageSize;
        public IntPtr MinimumAddress;
        public IntPtr MaximumAddress;
        public UIntPtr ProcessorMask;
        public uint ProcessorCount;
        public uint ProcessorType;
        public uint AllocationGranularity;
        public ushort ProcessorLevel;
        public ushort ProcessorRevision;
    }

    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern UIntPtr VirtualQueryEx(IntPtr process, IntPtr address, out MemoryInfo64 info, UIntPtr length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, [Out] byte[] buffer, UIntPtr size, out UIntPtr read);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll")] private static extern void GetNativeSystemInfo(out SystemInfo info);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    private sealed class InputError : Exception
    {
        internal readonly string Code;
        internal InputError(string code) { Code = code; }
    }

    private sealed class State
    {
        internal readonly Stopwatch Clock = Stopwatch.StartNew();
        internal ulong Bytes;
        internal int Processes;
        internal int Candidates;
        internal bool Denied;
        internal bool Limited;
        internal long LastProgress;

        internal bool CanContinue()
        {
            if (OutputClosed) return false;
            if (Limited) return false;
            if (Candidates >= CandidateLimit || Bytes >= ByteLimit || Clock.Elapsed.TotalSeconds >= TimeLimitSeconds)
            {
                Limited = true;
                return false;
            }
            return true;
        }

        internal void Progress(bool force)
        {
            if (!force && Clock.ElapsedMilliseconds - LastProgress < 1000) return;
            LastProgress = Clock.ElapsedMilliseconds;
            Write(new { type = "progress", message = "正在读取微信进程", bytes = Bytes, processes = Processes });
        }
    }

    private sealed class MemoryReader
    {
        private readonly IntPtr process;
        private readonly State state;
        private readonly ulong maximum;

        internal MemoryReader(IntPtr processHandle, State scanState, ulong maximumAddress)
        {
            process = processHandle;
            state = scanState;
            maximum = maximumAddress;
        }

        internal bool Query(ulong address, out MemoryInfo64 info)
        {
            if (address > maximum) { info = new MemoryInfo64(); return false; }
            bool success = VirtualQueryEx(process, Address(address), out info, new UIntPtr(48)).ToUInt64() >= 48;
            if (!success && Marshal.GetLastWin32Error() == 5) state.Denied = true;
            return success;
        }

        internal int Read(ulong address, byte[] buffer, int size)
        {
            if (!state.CanContinue() || size <= 0 || address > maximum) return 0;
            ulong available = ByteLimit - state.Bytes;
            size = (int)Math.Min((ulong)size, available);
            UIntPtr read;
            // ERROR_PARTIAL_COPY can still return valid bytes. Never parse the
            // buffer beyond that returned byte count.
            bool success = ReadProcessMemory(process, Address(address), buffer, new UIntPtr((uint)size), out read);
            if (!success && Marshal.GetLastWin32Error() == 5) state.Denied = true;
            ulong amount = Math.Min(read.ToUInt64(), (ulong)size);
            state.Bytes += amount;
            return (int)amount;
        }

        internal byte[] ReadKey(ulong pointer)
        {
            if (pointer < 0x10000 || pointer > maximum - 32 || !state.CanContinue()) return null;
            MemoryInfo64 info;
            if (!Query(pointer, out info) || !ReadablePrivate(info) || pointer < info.BaseAddress ||
                info.RegionSize < 32 || pointer - info.BaseAddress > info.RegionSize - 32) return null;
            byte[] key = new byte[32];
            if (Read(pointer, key, key.Length) != key.Length) { Array.Clear(key, 0, key.Length); return null; }
            return key;
        }
    }

    private sealed class Parser
    {
        private readonly HashSet<string> salts;
        private readonly HashSet<string> emitted = new HashSet<string>(StringComparer.Ordinal);
        private readonly HashSet<ulong> pointers = new HashSet<ulong>();
        private readonly State state;
        private readonly Action<string, string> accept;

        internal Parser(HashSet<string> allowedSalts, State scanState, Action<string, string> onCandidate)
        {
            salts = allowedSalts;
            state = scanState;
            accept = onCandidate;
        }

        internal void BeginProcess() { pointers.Clear(); }

        private void Candidate(string key, string salt)
        {
            if (!state.CanContinue()) return;
            string identity = key + ":" + (salt ?? "");
            if (!emitted.Add(identity)) return;
            state.Candidates++;
            accept(key, salt);
            if (state.Candidates >= CandidateLimit) state.Limited = true;
        }

        private void Literal(byte[] data, int start, int count, bool wide)
        {
            int step = wide ? 2 : 1;
            int position = start + 2 * step;
            int length = 0;
            while (length <= 96 && position + (wide ? 1 : 0) < count && IsHex(data[position]) && (!wide || data[position + 1] == 0))
            {
                length++;
                position += step;
            }
            if ((length != 64 && length != 96) || position + (wide ? 1 : 0) >= count || data[position] != 39 || (wide && data[position + 1] != 0)) return;
            char[] text = new char[length];
            for (int index = 0; index < length; index++) text[index] = Char.ToLowerInvariant((char)data[start + 2 * step + index * step]);
            string salt = length == 96 ? new string(text, 64, 32) : null;
            // An explicit salt that does not belong to a selected DB is never
            // downgraded into an unassociated raw-key candidate.
            if (salt != null && !salts.Contains(salt)) { Array.Clear(text, 0, text.Length); return; }
            string key = new string(text, 0, 64);
            Array.Clear(text, 0, text.Length);
            Candidate(key, salt);
        }

        internal void Parse(byte[] data, int count, MemoryReader memory)
        {
            for (int index = 0; index < count; index++)
            {
                if ((index & 4095) == 0 && !state.CanContinue()) return;
                byte value = data[index];
                if (value == 120 || value == 88)
                {
                    if (count - index >= 67 && data[index + 1] == 39) Literal(data, index, count, false);
                    if (count - index >= 134 && data[index + 1] == 0 && data[index + 2] == 39 && data[index + 3] == 0) Literal(data, index, count, true);
                }
                if (count - index < 32 || data[index + 16] != 32) continue;
                // MSVC's non-small-string layout on 64-bit Windows: pointer,
                // unused union bytes, length=32, then capacity in [32,128].
                // The unused bytes can retain an earlier small-string value.
                if (BitConverter.ToUInt64(data, index + 16) != 32) continue;
                ulong capacity = BitConverter.ToUInt64(data, index + 24);
                if (capacity < 32 || capacity > 128) continue;
                ulong pointer = BitConverter.ToUInt64(data, index);
                if (!pointers.Add(pointer)) continue;
                byte[] candidate = memory.ReadKey(pointer);
                if (candidate == null) continue;
                try { if (HasEntropy(candidate)) Candidate(Hex(candidate), null); }
                finally { Array.Clear(candidate, 0, candidate.Length); }
            }
        }
    }

    private static IntPtr Address(ulong address) { return new IntPtr(unchecked((long)address)); }
    private static void Write(object record)
    {
        if (OutputClosed) return;
        try { Output.WriteLine(Json.Serialize(record)); }
        catch { OutputClosed = true; }
    }
    private static void Error(string code) { try { Console.Error.WriteLine(code); } catch { } }
    private static bool IsHex(byte value) { return value >= 48 && value <= 57 || value >= 65 && value <= 70 || value >= 97 && value <= 102; }
    private static bool IsHexText(string value, int length)
    {
        if (value == null || value.Length != length) return false;
        for (int index = 0; index < value.Length; index++) if (value[index] > 127 || !IsHex((byte)value[index])) return false;
        return true;
    }
    private static string Hex(byte[] bytes)
    {
        char[] chars = new char[bytes.Length * 2];
        const string digits = "0123456789abcdef";
        for (int index = 0; index < bytes.Length; index++) { chars[index * 2] = digits[bytes[index] >> 4]; chars[index * 2 + 1] = digits[bytes[index] & 15]; }
        string result = new string(chars);
        Array.Clear(chars, 0, chars.Length);
        return result;
    }

    private static bool HasEntropy(byte[] bytes)
    {
        int[] frequencies = new int[256];
        foreach (byte value in bytes) frequencies[value]++;
        int distinct = 0;
        double entropy = 0;
        foreach (int frequency in frequencies)
        {
            if (frequency == 0) continue;
            distinct++;
            double probability = (double)frequency / bytes.Length;
            entropy -= probability * Math.Log(probability, 2);
        }
        return distinct >= 16 && frequencies[0] <= 8 && entropy >= 3.5;
    }

    private static bool ReadablePrivate(MemoryInfo64 info)
    {
        if (info.State != MemCommit || info.Type != MemPrivate || (info.Protect & 0x100) != 0) return false;
        uint protection = info.Protect & 0xff;
        return protection == 0x02 || protection == 0x04 || protection == 0x08 || protection == 0x20 || protection == 0x40 || protection == 0x80;
    }

    private static HashSet<string> ReadInput()
    {
        byte[] input = new byte[InputLimit + 1];
        int count = 0;
        using (Stream stream = Console.OpenStandardInput())
        {
            while (count < input.Length)
            {
                int read = stream.Read(input, count, input.Length - count);
                if (read == 0) break;
                count += read;
            }
        }
        if (count > InputLimit) throw new InputError("INPUT_TOO_LARGE");
        try
        {
            string text = new UTF8Encoding(false, true).GetString(input, 0, count).TrimStart('\ufeff');
            Dictionary<string, object> request = Json.DeserializeObject(text) as Dictionary<string, object>;
            object value;
            if (request == null || request.Count != 1 || !request.TryGetValue("salts", out value)) throw new InputError("INPUT_INVALID");
            object[] list = value as object[];
            if (list == null || list.Length == 0) throw new InputError("INPUT_INVALID");
            HashSet<string> salts = new HashSet<string>(StringComparer.Ordinal);
            foreach (object item in list)
            {
                string salt = item as string;
                if (!IsHexText(salt, 32)) throw new InputError("INPUT_INVALID");
                salts.Add(salt.ToLowerInvariant());
            }
            return salts;
        }
        catch (InputError) { throw; }
        catch { throw new InputError("INPUT_INVALID"); }
        finally { Array.Clear(input, 0, input.Length); }
    }

    private static bool SameUser(IntPtr process, string currentSid)
    {
        bool same;
        return QuerySameUser(process, currentSid, out same) && same;
    }

    private static bool QuerySameUser(IntPtr process, string currentSid, out bool same)
    {
        same = false;
        IntPtr token;
        if (!OpenProcessToken(process, TokenQuery, out token)) return false;
        try
        {
            using (WindowsIdentity identity = new WindowsIdentity(token))
            {
                if (identity.User == null) return false;
                same = String.Equals(identity.User.Value, currentSid, StringComparison.OrdinalIgnoreCase);
                return true;
            }
        }
        catch { return false; }
        finally { CloseHandle(token); }
    }

    private static bool CorrectImage(IntPtr process)
    {
        StringBuilder image = new StringBuilder(32768);
        int length = image.Capacity;
        if (!QueryFullProcessImageName(process, 0, image, ref length)) return false;
        string name = Path.GetFileName(image.ToString());
        return String.Equals(name, "Weixin.exe", StringComparison.OrdinalIgnoreCase) || String.Equals(name, "WeChat.exe", StringComparison.OrdinalIgnoreCase);
    }

    private static List<int> FindProcessIds()
    {
        HashSet<int> ids = new HashSet<int>();
        foreach (string name in new string[] { "Weixin", "WeChat" })
        {
            Process[] processes = Process.GetProcessesByName(name);
            foreach (Process process in processes)
            {
                try { ids.Add(process.Id); } catch { }
                finally { process.Dispose(); }
            }
        }
        List<int> result = new List<int>(ids);
        result.Sort();
        return result;
    }

    // Metadata-only preflight. Uses limited-query access and token metadata,
    // without VM_READ, memory enumeration, process IDs or identity output.
    private static int Diagnose()
    {
        int processes = 0, accessible = 0, sameUser = 0, differentUser = 0;
        bool denied = false;
        int result = 0;
        try
        {
            uint currentSession;
            if (!ProcessIdToSessionId(GetCurrentProcessId(), out currentSession)) throw new InputError("SESSION_QUERY_FAILED");
            string sid;
            using (WindowsIdentity current = WindowsIdentity.GetCurrent())
            {
                if (current.User == null) throw new InputError("USER_QUERY_FAILED");
                sid = current.User.Value;
            }
            foreach (int pid in FindProcessIds())
            {
                uint session;
                if (!ProcessIdToSessionId((uint)pid, out session)) { denied = true; continue; }
                if (session != currentSession) continue;
                processes++;
                IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, pid);
                if (process == IntPtr.Zero) { denied = true; continue; }
                try
                {
                    if (!CorrectImage(process)) { denied = true; continue; }
                    accessible++;
                    bool same;
                    if (!QuerySameUser(process, sid, out same)) { denied = true; continue; }
                    if (same) sameUser++; else differentUser++;
                }
                finally { CloseHandle(process); }
            }
        }
        catch { denied = true; Error("DIAGNOSTIC_FAILED"); result = 1; }
        Write(new { type = "diagnostic", processes = processes, accessibleProcesses = accessible, sameUserProcesses = sameUser, differentUserProcesses = differentUser, denied = denied });
        return OutputClosed ? 1 : result;
    }

    private static void ScanProcess(IntPtr process, State state, Parser parser, ulong minimum, ulong maximum)
    {
        // Virtual addresses identify memory only within one process. Keep key
        // deduplication global, but never reuse another process's pointer cache.
        parser.BeginProcess();
        MemoryReader reader = new MemoryReader(process, state, maximum);
        byte[] chunk = new byte[ChunkBytes];
        ulong cursor = minimum;
        try
        {
            while (cursor < maximum && state.CanContinue())
            {
                MemoryInfo64 info;
                if (!reader.Query(cursor, out info) || info.RegionSize == 0 || info.BaseAddress > UInt64.MaxValue - info.RegionSize) break;
                ulong end = Math.Min(info.BaseAddress + info.RegionSize, maximum);
                if (end <= cursor) break;
                if (ReadablePrivate(info))
                {
                    ulong position = Math.Max(cursor, info.BaseAddress);
                    while (position < end && state.CanContinue())
                    {
                        int size = (int)Math.Min((ulong)chunk.Length, end - position);
                        int read = reader.Read(position, chunk, size);
                        if (read > 0) parser.Parse(chunk, read, reader);
                        state.Progress(false);
                        ulong advance = read > OverlapBytes ? (ulong)(read - OverlapBytes) : (ulong)Math.Max(read, 4096);
                        if (read == size && position + (ulong)read == end) position = end;
                        else position += Math.Min(advance, end - position);
                    }
                }
                cursor = end;
            }
        }
        finally { Array.Clear(chunk, 0, chunk.Length); }
    }

    private static int Scan(HashSet<string> salts, State state)
    {
        uint currentSession;
        if (!ProcessIdToSessionId(GetCurrentProcessId(), out currentSession)) throw new InputError("SESSION_QUERY_FAILED");
        string sid;
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
        {
            if (identity.User == null) throw new InputError("USER_QUERY_FAILED");
            sid = identity.User.Value;
        }
        SystemInfo system;
        GetNativeSystemInfo(out system);
        ulong minimum = unchecked((ulong)system.MinimumAddress.ToInt64());
        ulong maximum = unchecked((ulong)system.MaximumAddress.ToInt64());
        Parser parser = new Parser(salts, state, delegate(string key, string salt)
        {
            if (salt == null) Write(new { type = "candidate", key = key });
            else Write(new { type = "candidate", key = key, salt = salt });
        });
        state.Progress(true);
        foreach (int pid in FindProcessIds())
        {
            if (!state.CanContinue()) break;
            uint session;
            if (!ProcessIdToSessionId((uint)pid, out session) || session != currentSession) continue;
            IntPtr process = OpenProcess(ProcessQueryAndRead, false, pid);
            if (process == IntPtr.Zero) { state.Denied = true; continue; }
            try
            {
                if (!CorrectImage(process)) continue;
                if (!SameUser(process, sid)) { state.Denied = true; continue; }
                state.Processes++;
                state.Progress(true);
                ScanProcess(process, state, parser, minimum, maximum);
            }
            finally { CloseHandle(process); }
        }
        state.Progress(true);
        return 0;
    }

    private static byte[] SyntheticKey(string label)
    {
        using (SHA256 hash = SHA256.Create()) { return hash.ComputeHash(Encoding.ASCII.GetBytes("yaozhuo synthetic self-test " + label)); }
    }

    private static int SelfTest()
    {
        IntPtr process = IntPtr.Zero, block = IntPtr.Zero, keyMemory = IntPtr.Zero, lowMemory = IntPtr.Zero;
        byte[] data = new byte[4096];
        byte[] a = SyntheticKey("ascii"), b = SyntheticKey("utf16"), c = SyntheticKey("key-only"), d = SyntheticKey("pointer");
        try
        {
            const string saltA = "00112233445566778899aabbccddeeff";
            const string saltB = "ffeeddccbbaa99887766554433221100";
            HashSet<string> salts = new HashSet<string>(new string[] { saltA, saltB });
            HashSet<string> expected = new HashSet<string>(new string[] { Hex(a) + ":" + saltA, Hex(b) + ":" + saltB, Hex(c) + ":", Hex(d) + ":" });
            HashSet<string> actual = new HashSet<string>();
            byte[] ascii = Encoding.ASCII.GetBytes("x'" + Hex(a) + saltA + "'");
            Buffer.BlockCopy(ascii, 0, data, 71, ascii.Length);
            Buffer.BlockCopy(ascii, 0, data, 250, ascii.Length); // exact duplicate
            byte[] unicode = Encoding.Unicode.GetBytes("x'" + Hex(b).ToUpperInvariant() + saltB.ToUpperInvariant() + "'");
            Buffer.BlockCopy(unicode, 0, data, 503, unicode.Length); // deliberately unaligned
            byte[] only = Encoding.ASCII.GetBytes("x'" + Hex(c) + "'");
            Buffer.BlockCopy(only, 0, data, 901, only.Length);
            byte[] excluded = Encoding.ASCII.GetBytes("x'" + Hex(a) + "11111111111111111111111111111111'");
            Buffer.BlockCopy(excluded, 0, data, 1201, excluded.Length);
            keyMemory = Marshal.AllocHGlobal(32);
            Marshal.Copy(d, 0, keyMemory, d.Length);
            lowMemory = Marshal.AllocHGlobal(32);
            Marshal.Copy(new byte[32], 0, lowMemory, 32);
            Buffer.BlockCopy(BitConverter.GetBytes(unchecked((ulong)keyMemory.ToInt64())), 0, data, 1600, 8);
            Buffer.BlockCopy(Encoding.ASCII.GetBytes("old SSO!"), 0, data, 1608, 8);
            Buffer.BlockCopy(BitConverter.GetBytes(32UL), 0, data, 1616, 8);
            Buffer.BlockCopy(BitConverter.GetBytes(64UL), 0, data, 1624, 8);
            Buffer.BlockCopy(BitConverter.GetBytes(unchecked((ulong)lowMemory.ToInt64())), 0, data, 1800, 8);
            Buffer.BlockCopy(BitConverter.GetBytes(32UL), 0, data, 1816, 8);
            Buffer.BlockCopy(BitConverter.GetBytes(32UL), 0, data, 1824, 8);
            block = Marshal.AllocHGlobal(data.Length);
            Marshal.Copy(data, 0, block, data.Length);
            process = OpenProcess(ProcessQueryAndRead, false, (int)GetCurrentProcessId());
            if (process == IntPtr.Zero) throw new InputError("SELF_TEST_HANDLE_FAILED");
            SystemInfo system;
            GetNativeSystemInfo(out system);
            State state = new State();
            MemoryReader memory = new MemoryReader(process, state, unchecked((ulong)system.MaximumAddress.ToInt64()));
            byte[] read = new byte[data.Length];
            bool memoryRead = memory.Read(unchecked((ulong)block.ToInt64()), read, read.Length) == read.Length;
            Parser parser = new Parser(salts, state, delegate(string key, string salt) { actual.Add(key + ":" + (salt ?? "")); });
            if (memoryRead) parser.Parse(read, read.Length, memory);
            Array.Clear(read, 0, read.Length);
            bool entropy = !HasEntropy(new byte[32]) && HasEntropy(d);
            bool protection = SelfTestProfileProtection();
            bool success = memoryRead && entropy && protection && actual.SetEquals(expected) && state.Candidates == expected.Count;
            Write(new { type = "self-test", success = success, architecture = IntPtr.Size * 8, candidates = state.Candidates, memoryRead = memoryRead, ascii96 = actual.Contains(Hex(a) + ":" + saltA), utf16 = actual.Contains(Hex(b) + ":" + saltB), keyOnly = actual.Contains(Hex(c) + ":"), pointer32 = actual.Contains(Hex(d) + ":"), entropyFilter = entropy, deduplicated = state.Candidates == actual.Count, profileProtection = protection });
            if (!success) Error("SELF_TEST_FAILED");
            return success ? 0 : 1;
        }
        finally
        {
            if (process != IntPtr.Zero) CloseHandle(process);
            if (block != IntPtr.Zero) { Marshal.Copy(new byte[data.Length], 0, block, data.Length); Marshal.FreeHGlobal(block); }
            if (keyMemory != IntPtr.Zero) { Marshal.Copy(new byte[32], 0, keyMemory, 32); Marshal.FreeHGlobal(keyMemory); }
            if (lowMemory != IntPtr.Zero) Marshal.FreeHGlobal(lowMemory);
            Array.Clear(data, 0, data.Length); Array.Clear(a, 0, a.Length); Array.Clear(b, 0, b.Length); Array.Clear(c, 0, c.Length); Array.Clear(d, 0, d.Length);
        }
    }

    private static bool SelfTestProfileProtection()
    {
        byte[] original = SyntheticKey("profile storage"), protectedBytes = null, restored = null;
        try
        {
            protectedBytes = ProtectedData.Protect(original, null, DataProtectionScope.CurrentUser);
            restored = ProtectedData.Unprotect(protectedBytes, null, DataProtectionScope.CurrentUser);
            if (restored.Length != original.Length) return false;
            int difference = 0;
            for (int index = 0; index < original.Length; index++) difference |= original[index] ^ restored[index];
            return difference == 0;
        }
        finally
        {
            Array.Clear(original, 0, original.Length);
            if (protectedBytes != null) Array.Clear(protectedBytes, 0, protectedBytes.Length);
            if (restored != null) Array.Clear(restored, 0, restored.Length);
        }
    }

    // This mode has one fixed source and accepts no path/ciphertext from stdin.
    // It restores this user's already saved Chromium storage key only; it never
    // enumerates processes, writes files, or accepts another DPAPI target.
    private static int ReadWeFlowProfileKey()
    {
        byte[] protectedBytes = null, wrapped = null, key = null, jsonBytes = null;
        try
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            if (String.IsNullOrEmpty(appData)) throw new InputError("PROFILE_UNAVAILABLE");
            string directory = Path.Combine(appData, "WeFlow");
            string filename = Path.Combine(directory, "Local State");
            if (!Directory.Exists(directory) || !File.Exists(filename) ||
                (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0 ||
                (File.GetAttributes(filename) & FileAttributes.ReparsePoint) != 0) throw new InputError("PROFILE_UNAVAILABLE");
            const int maximum = 2 * 1024 * 1024;
            using (FileStream stream = new FileStream(filename, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                if (stream.Length <= 0 || stream.Length > maximum) throw new InputError("PROFILE_INVALID");
                jsonBytes = new byte[(int)stream.Length];
                int offset = 0;
                while (offset < jsonBytes.Length)
                {
                    int read = stream.Read(jsonBytes, offset, jsonBytes.Length - offset);
                    if (read == 0) throw new InputError("PROFILE_INVALID");
                    offset += read;
                }
            }
            JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = maximum, RecursionLimit = 32 };
            Dictionary<string, object> localState = serializer.DeserializeObject(new UTF8Encoding(false, true).GetString(jsonBytes).TrimStart('\ufeff')) as Dictionary<string, object>;
            object cryptValue, encryptedValue;
            if (localState == null || !localState.TryGetValue("os_crypt", out cryptValue)) throw new InputError("PROFILE_INVALID");
            Dictionary<string, object> crypt = cryptValue as Dictionary<string, object>;
            if (crypt == null || !crypt.TryGetValue("encrypted_key", out encryptedValue) || !(encryptedValue is string)) throw new InputError("PROFILE_INVALID");
            string encoded = (string)encryptedValue;
            if (encoded.Length > 16384) throw new InputError("PROFILE_INVALID");
            wrapped = Convert.FromBase64String(encoded);
            if (wrapped.Length <= 5 || wrapped[0] != 68 || wrapped[1] != 80 || wrapped[2] != 65 || wrapped[3] != 80 || wrapped[4] != 73) throw new InputError("PROFILE_INVALID");
            protectedBytes = new byte[wrapped.Length - 5];
            Buffer.BlockCopy(wrapped, 5, protectedBytes, 0, protectedBytes.Length);
            key = ProtectedData.Unprotect(protectedBytes, null, DataProtectionScope.CurrentUser);
            if (key.Length != 32) throw new InputError("PROFILE_INVALID");
            Write(new { type = "storage-key", key = Convert.ToBase64String(key) });
            return OutputClosed ? 1 : 0;
        }
        catch (InputError error) { Error(error.Code); return 2; }
        catch { Error("PROFILE_DECRYPT_FAILED"); return 1; }
        finally
        {
            if (jsonBytes != null) Array.Clear(jsonBytes, 0, jsonBytes.Length);
            if (protectedBytes != null) Array.Clear(protectedBytes, 0, protectedBytes.Length);
            if (wrapped != null) Array.Clear(wrapped, 0, wrapped.Length);
            if (key != null) Array.Clear(key, 0, key.Length);
        }
    }

    private static int Main(string[] args)
    {
        if (IntPtr.Size != 8) { Error("ARCH_64_REQUIRED"); return 2; }
        if (args.Length == 1 && args[0] == "--self-test")
        {
            try { return SelfTest(); }
            catch { Error("SELF_TEST_FAILED"); Write(new { type = "self-test", success = false }); return 1; }
        }
        if (args.Length == 1 && args[0] == "--weflow-profile-key") return ReadWeFlowProfileKey();
        if (args.Length == 1 && args[0] == "--diagnose") return Diagnose();
        State state = new State();
        int result = 0;
        try
        {
            if (args.Length != 0) throw new InputError("ARGUMENT_INVALID");
            HashSet<string> salts = ReadInput();
            result = Scan(salts, state);
        }
        catch (InputError error) { Error(error.Code); result = 2; }
        catch { Error("READ_FAILED"); result = 1; }
        finally { Write(new { type = "complete", processes = state.Processes, candidates = state.Candidates, denied = state.Denied, limited = state.Limited }); }
        if (OutputClosed) { Error("OUTPUT_CLOSED"); return 1; }
        return result;
    }
}
