/*
 * The AGC oracle's harness: runs a rope image on yaAGC's engine (Virtual AGC, agc_engine.c, fetched by
 * .github/workflows/agc-oracle.yml at a pinned revision, never kept in this repository) one instruction at a time and
 * prints the machine's state after each, for scripts/agc/oracle.ts to compare with src/agc/iss.ts.
 *
 *   harness <rope.bin> <instructions>
 *
 * The machine is held the way the golden model runs: erasable memory cleared, Z = 04000, no interrupt, the scaler held
 * (so no counter ticks, no alarm, no restart). Each output line, all numbers octal:
 *   S <cycles> <Z> <A> <L> <Q> <EB> <FB> <BB> <extracode> <index> [addr=value ...]
 * where the addresses are the erasable words (bank * 0400 + offset) that changed since the previous line.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "yaAGC.h"
#include "agc_engine.h"

/* The peripheral interface yaAGC calls: nothing is attached. */
void ChannelOutput(agc_t *State, int Channel, int Value) { (void)State; (void)Channel; (void)Value; }
int ChannelInput(agc_t *State) { (void)State; return 0; }
void ChannelRoutine(agc_t *State) { (void)State; }
void ShiftToDeda(agc_t *State, int Data) { (void)State; (void)Data; }
void RequestRadarData(agc_t *State) { (void)State; }
void BacktraceAdd(agc_t *State, int Cause) { (void)State; (void)Cause; }
int initializeSunburst37 = 0;

static agc_t S;
static int16_t prev[8][0400];

static int load(const char *path) {
  FILE *f = fopen(path, "rb");
  if (!f) return 1;
  /* banks 2, 3, 0, 1, 4 ... in the file (agc_load_binfile's order), each word big-endian, value << 1 */
  static const int order[4] = { 2, 3, 0, 1 };
  unsigned char b[2];
  int n = 0;
  while (fread(b, 1, 2, f) == 2) {
    int bank = n >> 10, j = n & 01777;
    if (bank >= 36) break;
    bank = bank < 4 ? order[bank] : bank;
    S.Fixed[bank][j] = (int16_t)(((b[0] << 8) | b[1]) >> 1);
    n++;
  }
  fclose(f);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: harness rope.bin instructions\n"); return 2; }
  memset(&S, 0, sizeof S);
  if (load(argv[1])) { fprintf(stderr, "cannot read %s\n", argv[1]); return 2; }
  long want = atol(argv[2]);
  S.Erasable[0][RegZ] = 04000;
  S.InputChannel[030] = 037777;
  S.InputChannel[031] = 077777;
  S.InputChannel[032] = 077777;
  S.InputChannel[033] = 077777;
  S.AllowInterrupt = 0;
  S.DownruptTimeValid = 0;
  InhibitAlarms = 1;
  memcpy(prev, S.Erasable, sizeof prev);
  long done = 0;
  unsigned long long last = 0, calls = 0;
  while (done < want && calls < 100000000ULL) {
    int pending = S.PendFlag;
    S.ScalerCounter = 0;
    S.DownruptTimeValid = 0;
    agc_engine(&S);
    calls++;
    if (S.PendFlag) continue; /* a multi-cycle instruction is under way */
    (void)pending;
    done++;
    printf("S %llo %o %o %o %o %o %o %o %o %o", (unsigned long long)(S.CycleCounter - last),
           S.Erasable[0][RegZ] & 0177777, S.Erasable[0][RegA] & 0177777, S.Erasable[0][RegL] & 0177777,
           S.Erasable[0][RegQ] & 0177777, S.Erasable[0][RegEB] & 0177777, S.Erasable[0][RegFB] & 0177777,
           S.Erasable[0][RegBB] & 0177777, S.ExtraCode ? 1 : 0, S.IndexValue & 0177777);
    last = S.CycleCounter;
    for (int b = 0; b < 8; b++)
      for (int j = 0; j < 0400; j++)
        if (S.Erasable[b][j] != prev[b][j] && !(b == 0 && j < 010)) {
          printf(" %o=%o", b * 0400 + j, S.Erasable[b][j] & 0177777);
          prev[b][j] = S.Erasable[b][j];
        }
    printf("\n");
  }
  return 0;
}
