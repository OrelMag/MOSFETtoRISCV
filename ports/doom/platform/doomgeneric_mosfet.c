/* doomgeneric's platform layer for the MOSFET -> RISC-V Doom machine.
   The picture itself never passes through here: i_video.c (patched) points Doom's
   I_VideoBuffer at the frame buffer and writes the palette registers; DG_DrawFrame
   only tells the screen that a frame is complete. */

#include <stdint.h>
#include <stdio.h>

#include "doomgeneric.h"
#include "mosfet.h"

void DG_Init(void)
{
}

void DG_DrawFrame(void)
{
	MOSFET_FLIP = 1;
}

uint32_t DG_GetTicksMs(void)
{
	return (uint32_t)(mosfet_cycles() / MOSFET_CYCLES_PER_MS);
}

void DG_SleepMs(uint32_t ms)
{
	uint64_t until = mosfet_cycles() + (uint64_t)ms * MOSFET_CYCLES_PER_MS;
	while (mosfet_cycles() < until) __asm__ volatile("wfi");
}

int DG_GetKey(int *pressed, unsigned char *key)
{
	uint32_t e = MOSFET_KEY;
	if (e == 0) return 0;
	*pressed = (e >> 8) & 1;
	*key = (unsigned char)(e & 0xff);
	return 1;
}

void DG_SetWindowTitle(const char *title)
{
	(void)title;
}

int main(void)
{
	/* -mb: the zone size in MiB (see README); -nogui: I_Error never tries a dialog box */
	static char *argv[] = { "doom", "-iwad", MOSFET_IWAD_NAME, "-mb", DOOM_ZONE_MB, "-nogui", 0 };
	doomgeneric_Create(sizeof argv / sizeof argv[0] - 1, argv);
	for (;;) doomgeneric_Tick();
}
