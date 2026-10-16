/* newlib system calls for the MOSFET -> RISC-V Doom machine.
   stdout / stderr go to CONSOLE; the only file is the IWAD, mapped read-only at
   0x1000_0000; every other open fails (so config and save games are not written). */

#include <errno.h>
#include <stdint.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/times.h>
#include <sys/types.h>
#include <fcntl.h>
#include <unistd.h>

#include "mosfet.h"

void mosfet_halt(void)
{
	for (;;) __asm__ volatile("1: j 1b");
}

void mosfet_puts(const char *s)
{
	while (*s) MOSFET_CONSOLE = (unsigned char)*s++;
}

static void put_hex(uint32_t v)
{
	mosfet_puts("0x");
	for (int i = 28; i >= 0; i -= 4) MOSFET_CONSOLE = "0123456789abcdef"[(v >> i) & 15];
}

/* crt0's trap entry: report and halt (no printf: the trap may have come from inside it). */
void mosfet_trap(uint32_t mcause, uint32_t mepc, uint32_t mtval) __attribute__((noreturn));
void mosfet_trap(uint32_t mcause, uint32_t mepc, uint32_t mtval)
{
	mosfet_puts("\ntrap mcause=");
	put_hex(mcause);
	mosfet_puts(" mepc=");
	put_hex(mepc);
	mosfet_puts(" mtval=");
	put_hex(mtval);
	mosfet_puts("\n");
	mosfet_halt();
}

/* MTIME is 32 bits and wraps every 107 s at 40 MHz; it is read at least once a frame. */
uint64_t mosfet_cycles(void)
{
	static uint32_t last, wraps;
	uint32_t now = MOSFET_MTIME;
	if (now < last) wraps++;
	last = now;
	return ((uint64_t)wraps << 32) | now;
}

/* ---- heap ---- */

extern char _end[], __stack_top[], __stack_reserve[];
static char *brk = _end;

void *_sbrk(ptrdiff_t incr)
{
	char *limit = __stack_top - (uintptr_t)__stack_reserve;
	char *old = brk;
	if (incr < 0 ? (uintptr_t)-incr > (uintptr_t)(brk - _end) : (uintptr_t)incr > (uintptr_t)(limit - brk)) {
		errno = ENOMEM;
		return (void *)-1;
	}
	brk += incr;
	return old;
}

/* ---- files: 0-2 the console, 3.. open views of the IWAD ---- */

#define MAX_WAD_FDS 4
static struct { int open; uint32_t pos; } wadfd[MAX_WAD_FDS];

static int wad_index(int fd)
{
	int i = fd - 3;
	return i >= 0 && i < MAX_WAD_FDS && wadfd[i].open ? i : -1;
}

static int is_iwad(const char *path)
{
	const char *base = path, *p;
	for (p = path; *p; p++)
		if (*p == '/' || *p == '\\') base = p + 1;
	const char *w = MOSFET_IWAD_NAME;
	for (; *base && *w; base++, w++) {
		char c = *base;
		if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
		if (c != *w) return 0;
	}
	return *base == 0 && *w == 0;
}

int _open(const char *path, int flags, int mode)
{
	(void)mode;
	if ((flags & O_ACCMODE) != O_RDONLY || !is_iwad(path)) {
		errno = (flags & O_ACCMODE) != O_RDONLY ? EROFS : ENOENT;
		return -1;
	}
	for (int i = 0; i < MAX_WAD_FDS; i++)
		if (!wadfd[i].open) {
			wadfd[i].open = 1;
			wadfd[i].pos = 0;
			return i + 3;
		}
	errno = EMFILE;
	return -1;
}

int _close(int fd)
{
	int i = wad_index(fd);
	if (i >= 0) wadfd[i].open = 0;
	return fd >= 0 && fd < 3 ? 0 : i >= 0 ? 0 : (errno = EBADF, -1);
}

int _read(int fd, char *buf, int len)
{
	int i = wad_index(fd);
	if (i < 0) return fd == 0 ? 0 : (errno = EBADF, -1);
	uint32_t size = MOSFET_WADLEN, pos = wadfd[i].pos;
	if (pos >= size) return 0;
	if ((uint32_t)len > size - pos) len = (int)(size - pos);
	memcpy(buf, MOSFET_WAD + pos, (size_t)len);
	wadfd[i].pos = pos + (uint32_t)len;
	return len;
}

int _write(int fd, const char *buf, int len)
{
	if (fd != 1 && fd != 2) {
		errno = EBADF;
		return -1;
	}
	for (int k = 0; k < len; k++) MOSFET_CONSOLE = (unsigned char)buf[k];
	return len;
}

int _lseek(int fd, int off, int whence)
{
	int i = wad_index(fd);
	if (i < 0) {
		errno = fd >= 0 && fd < 3 ? ESPIPE : EBADF;
		return -1;
	}
	int64_t base = whence == SEEK_SET ? 0 : whence == SEEK_CUR ? wadfd[i].pos : (int64_t)MOSFET_WADLEN;
	int64_t p = base + off;
	if (p < 0) {
		errno = EINVAL;
		return -1;
	}
	wadfd[i].pos = (uint32_t)p;
	return (int)p;
}

int _fstat(int fd, struct stat *st)
{
	memset(st, 0, sizeof *st);
	if (fd >= 0 && fd < 3) {
		st->st_mode = S_IFCHR;
		return 0;
	}
	if (wad_index(fd) < 0) {
		errno = EBADF;
		return -1;
	}
	st->st_mode = S_IFREG | 0444;
	st->st_size = (off_t)MOSFET_WADLEN;
	return 0;
}

int _stat(const char *path, struct stat *st)
{
	memset(st, 0, sizeof *st);
	if (!is_iwad(path)) {
		errno = ENOENT;
		return -1;
	}
	st->st_mode = S_IFREG | 0444;
	st->st_size = (off_t)MOSFET_WADLEN;
	return 0;
}

int _isatty(int fd)
{
	return fd >= 0 && fd < 3;
}

int _unlink(const char *path) { (void)path; errno = EROFS; return -1; }
int _link(const char *a, const char *b) { (void)a; (void)b; errno = EROFS; return -1; }
int _rename(const char *a, const char *b) { (void)a; (void)b; errno = EROFS; return -1; }
int mkdir(const char *path, mode_t mode) { (void)path; (void)mode; errno = EROFS; return -1; }

int _gettimeofday(struct timeval *tv, void *tz)
{
	(void)tz;
	uint64_t us = mosfet_cycles() / (MOSFET_HZ / 1000000u);
	tv->tv_sec = (time_t)(us / 1000000u);
	tv->tv_usec = (suseconds_t)(us % 1000000u);
	return 0;
}

clock_t _times(struct tms *t)
{
	memset(t, 0, sizeof *t);
	return (clock_t)-1;
}

int _getpid(void) { return 1; }
int _kill(int pid, int sig) { (void)pid; (void)sig; errno = EINVAL; return -1; }
int _fork(void) { errno = ENOSYS; return -1; }
int _execve(const char *n, char *const a[], char *const e[]) { (void)n; (void)a; (void)e; errno = ENOSYS; return -1; }
int _wait(int *s) { (void)s; errno = ECHILD; return -1; }

void _exit(int status)
{
	mosfet_puts("\n[exit ");
	if (status < 0) {
		MOSFET_CONSOLE = '-';
		status = -status;
	}
	char d[12];
	int n = 0;
	do d[n++] = (char)('0' + status % 10); while ((status /= 10) && n < 11);
	while (n) MOSFET_CONSOLE = (unsigned char)d[--n];
	mosfet_puts("]\n");
	mosfet_halt();
}
