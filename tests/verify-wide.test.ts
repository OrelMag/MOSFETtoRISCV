// riscv-tests and random programs on the two-wide CPUs of chapter 24 (tests/verify/suite.ts).
import { verifyCpus } from './verify/suite';

verifyCpus(['pipe-2w', 'ooo']);
