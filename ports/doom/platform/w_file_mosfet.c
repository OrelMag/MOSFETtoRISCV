/* A wad_file_class over the memory-mapped IWAD at 0x1000_0000 (length: the WADLEN register).
   `mapped` is set, so W_CacheLumpNum returns pointers into the WAD itself: no lump is
   copied into the zone (the region is read-only; Doom never writes a cached lump). */

#include <string.h>
#include <strings.h>

#include "m_misc.h"
#include "w_file.h"
#include "z_zone.h"

#include "mosfet.h"

extern wad_file_class_t mosfet_wad_file;

static int is_iwad(const char *path)
{
	const char *base = path, *p;
	for (p = path; *p; p++)
		if (*p == '/' || *p == '\\') base = p + 1;
	return !strcasecmp(base, MOSFET_IWAD_NAME);
}

static wad_file_t *W_Mosfet_OpenFile(char *path)
{
	wad_file_t *result;
	if (!is_iwad(path)) return NULL;
	result = Z_Malloc(sizeof(wad_file_t), PU_STATIC, 0);
	result->file_class = &mosfet_wad_file;
	result->mapped = (byte *)MOSFET_WAD;
	result->length = MOSFET_WADLEN;
	return result;
}

static void W_Mosfet_CloseFile(wad_file_t *wad)
{
	Z_Free(wad);
}

static size_t W_Mosfet_Read(wad_file_t *wad, unsigned int offset, void *buffer, size_t buffer_len)
{
	if (offset >= wad->length) return 0;
	if (buffer_len > wad->length - offset) buffer_len = wad->length - offset;
	memcpy(buffer, wad->mapped + offset, buffer_len);
	return buffer_len;
}

wad_file_class_t mosfet_wad_file = {
	W_Mosfet_OpenFile,
	W_Mosfet_CloseFile,
	W_Mosfet_Read,
};
