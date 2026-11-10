// riscv-tests and random programs with the C forms on the pipelined RV32IC CPU, in lock step with ISS({ c }) (tests/verify/suite.ts).
import { verifyCpus } from './verify/suite';

verifyCpus(['pipe-c']);
