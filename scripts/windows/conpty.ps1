# The desk's pseudo-terminal on Windows: runs a command in a ConPTY, the pseudo-console
# Windows Terminal itself is built on (Windows 10 1809 and later), copies the bytes it
# draws to stdout, and reads framed input from stdin, the same frames as
# scripts/pty-bridge.py:
#   [type: 1 byte][length: 4 bytes, little-endian][payload]
#   type 0: keys to type; 1: resize (cols, rows: 2 bytes each, little-endian); 2: close
#
# The command, its folder and the size come in environment variables, so no quoting
# can go wrong on the way: AF_DESK_PTY_CMD, AF_DESK_PTY_CWD, AF_DESK_PTY_COLS, AF_DESK_PTY_ROWS.
#
# The C# below is compiled when this starts (Add-Type), so nothing is installed. That
# needs PowerShell's full language mode; a PC locked down to constrained mode refuses,
# and the desk shows the error in place of the terminal.
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace AfDesk {
  public static class Pty {
    [StructLayout(LayoutKind.Sequential)]
    public struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
      public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
      public int dwX; public int dwY; public int dwXSize; public int dwYSize;
      public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
      public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
      public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, IntPtr attributes, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern int CreatePseudoConsole(COORD size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr console);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern int ResizePseudoConsole(IntPtr console, COORD size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string folder, ref STARTUPINFOEX startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const int STARTF_USESTDHANDLES = 0x00000100;
    static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = (IntPtr)0x00020016;

    static bool ReadFull(Stream s, byte[] buffer, int count) {
      int got = 0;
      while (got < count) {
        int n = s.Read(buffer, got, count - got);
        if (n <= 0) return false;
        got += n;
      }
      return true;
    }

    public static int Run(string commandLine, string folder, short cols, short rows) {
      SafeFileHandle inRead, inWrite, outRead, outWrite;
      if (!CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0)) throw new Win32Exception();
      if (!CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0)) throw new Win32Exception();
      COORD start = new COORD(); start.X = cols; start.Y = rows;
      IntPtr console;
      int hr = CreatePseudoConsole(start, inRead, outWrite, 0, out console);
      if (hr != 0) throw new Win32Exception(hr);
      // The pseudo-console keeps its own copies of these two ends.
      inRead.Dispose();
      outWrite.Dispose();

      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      IntPtr list = Marshal.AllocHGlobal(size);
      if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Win32Exception();
      if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, console, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();

      STARTUPINFOEX startup = new STARTUPINFOEX();
      startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      // This process's own stdio is the desk's pipes. Without this flag the child
      // would write to them instead of to the pseudo-console.
      startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
      startup.lpAttributeList = list;
      PROCESS_INFORMATION info;
      if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, folder, ref startup, out info)) throw new Win32Exception();
      CloseHandle(info.hThread);
      IntPtr process = info.hProcess;

      Stream stdout = Console.OpenStandardOutput();
      FileStream screen = new FileStream(outRead, FileAccess.Read);
      Thread pump = new Thread(delegate () {
        byte[] buffer = new byte[16384];
        try {
          int n;
          while ((n = screen.Read(buffer, 0, buffer.Length)) > 0) { stdout.Write(buffer, 0, n); stdout.Flush(); }
        } catch (IOException) { }
      });
      pump.IsBackground = true;
      pump.Start();

      FileStream keys = new FileStream(inWrite, FileAccess.Write);
      Stream stdin = Console.OpenStandardInput();
      Thread reader = new Thread(delegate () {
        byte[] head = new byte[5];
        try {
          while (ReadFull(stdin, head, 5)) {
            int length = BitConverter.ToInt32(head, 1);
            byte[] body = new byte[length];
            if (!ReadFull(stdin, body, length)) break;
            if (head[0] == 0) { keys.Write(body, 0, length); keys.Flush(); }
            else if (head[0] == 1 && length >= 4) {
              COORD next = new COORD(); next.X = BitConverter.ToInt16(body, 0); next.Y = BitConverter.ToInt16(body, 2);
              ResizePseudoConsole(console, next);
            }
            else if (head[0] == 2) break;
          }
        } catch (IOException) { }
        // Closed from the desk, or the desk went away: the terminal ends too.
        TerminateProcess(process, 1);
      });
      reader.IsBackground = true;
      reader.Start();

      WaitForSingleObject(process, 0xFFFFFFFF);
      uint code;
      GetExitCodeProcess(process, out code);
      // Closing the pseudo-console ends its output; the pump drains what's left.
      ClosePseudoConsole(console);
      pump.Join(2000);
      CloseHandle(process);
      DeleteProcThreadAttributeList(list);
      Marshal.FreeHGlobal(list);
      return (int)code;
    }
  }
}
'@
$cols = if ($env:AF_DESK_PTY_COLS) { [int16]$env:AF_DESK_PTY_COLS } else { [int16]120 }
$rows = if ($env:AF_DESK_PTY_ROWS) { [int16]$env:AF_DESK_PTY_ROWS } else { [int16]32 }
exit [AfDesk.Pty]::Run($env:AF_DESK_PTY_CMD, $env:AF_DESK_PTY_CWD, $cols, $rows)
