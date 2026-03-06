/**
 * Piping Gas Meter Service
 *
 * Handles integration with Direct Piping Gas Meters via the Lorawan API.
 *
 * Unlike Token Meters, piping meters are recharged directly:
 * the Lorawan API sends the credit to the meter's controller via the IoT network.
 * No physical token is needed — the meter auto-updates.
 *
 * Flow:
 *  1. login()            → obtain apiToken (cached in gasLorawanService)
 *  2. getMeterInfo()     → validate meter exists
 *  3. rechargeMeter()    → top-up the meter, get orderId
 *  4. getRechargeStatus()→ poll until success / failed / timeout
 *
 * NOTE: This service delegates all API calls to gasLorawanService.js.
 *       The external interface (rechargePipingMeter) is intentionally
 *       unchanged so gasMeterRechargeController.ts needs no modification.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gasLorawanService = require('./gasLorawanService');

export interface PipingMeterRechargeParams {
    meterNumber: string;
    amount: number;        // Amount in RWF
    customerRef: string;   // Internal tracking reference
    customerPhone?: string;
}

export interface PipingMeterRechargeResult {
    success: boolean;
    meterNumber?: string;
    amount?: number;
    units?: number;
    apiReference?: string;   // orderId from Lorawan API
    message?: string;
    error?: string;
}

// How long (ms) to poll for a final status before giving up.
const POLL_TIMEOUT_MS = 30_000;  // 30 seconds
const POLL_INTERVAL_MS = 3_000;  // poll every 3 seconds

class PipingMeterService {

    /**
     * Main public method: recharge a piping gas meter via the Lorawan API.
     *
     * Steps:
     *   1. (Optional) Validate meter with getMeterInfo — skipped in DEV_MODE.
     *   2. Call rechargeMeter() to initiate top-up.
     *   3. Poll getRechargeStatus() until success/failed or timeout.
     */
    async rechargePipingMeter(params: PipingMeterRechargeParams): Promise<PipingMeterRechargeResult> {
        const isDev = process.env.DEV_MODE === 'true' || process.env.DEV_MODE === '1';

        // ── DEV MODE: return a simulated success ─────────────────────────
        if (isDev) {
            console.log(`🛠️ [PipingMeter DEV] Simulating Lorawan recharge for meter: ${params.meterNumber}, Amount: ${params.amount}`);
            const units = this.calculateUnits(params.amount);
            return {
                success: true,
                meterNumber: params.meterNumber,
                amount: params.amount,
                units,
                apiReference: `DEV-LORAWAN-${Date.now()}`,
                message: `Piping meter recharged successfully with ${units} m³ (DEV_MODE)`,
            };
        }

        // ── PRODUCTION: real Lorawan API call ────────────────────────────
        try {
            const devEui = params.meterNumber;

            // STEP 1: Validate meter exists before charging
            console.log(`[PipingMeter] Validating meter ${devEui}...`);
            const meterInfo = await gasLorawanService.getMeterInfo(devEui);

            if (!meterInfo.success) {
                console.warn(`[PipingMeter] Meter validation failed: ${meterInfo.error}`);
                return {
                    success: false,
                    error: meterInfo.error || 'Meter not found or invalid.',
                };
            }

            console.log(`[PipingMeter] Meter ${devEui} validated. Initiating top-up for ${params.amount}...`);

            // STEP 2: Recharge the meter
            const rechargeResult = await gasLorawanService.rechargeMeter(devEui, params.amount);

            if (!rechargeResult.success) {
                return {
                    success: false,
                    error: rechargeResult.error || 'Recharge initiation failed.',
                };
            }

            const { orderId } = rechargeResult;
            console.log(`[PipingMeter] Recharge submitted. orderId: ${orderId}. Polling for status...`);

            // STEP 3: Poll until we get a terminal status (success=2 or failed=3)
            const pollResult = await this.pollForFinalStatus(orderId);

            if (!pollResult.success) {
                return {
                    success: false,
                    error: pollResult.error || 'Recharge did not complete in time.',
                    apiReference: orderId,
                };
            }

            const units = this.calculateUnits(params.amount);

            return {
                success: true,
                meterNumber: params.meterNumber,
                amount: params.amount,
                units,
                apiReference: orderId,
                message: `Piping gas meter recharged successfully. Order ${orderId} confirmed.`,
            };

        } catch (error: any) {
            console.error('[PipingMeter] Unexpected error:', error.message);
            return {
                success: false,
                error: error.message || 'Failed to connect to Piping Meter (Lorawan) API',
            };
        }
    }

    /**
     * Poll getRechargeStatus() until the order reaches a terminal state
     * (status 2 = success, status 3 = failed) or the timeout is reached.
     */
    private async pollForFinalStatus(
        orderId: string,
    ): Promise<{ success: boolean; error?: string }> {
        const deadline = Date.now() + POLL_TIMEOUT_MS;

        while (Date.now() < deadline) {
            const statusResult = await gasLorawanService.getRechargeStatus(orderId);

            if (!statusResult.success) {
                // API call itself failed — treat as error but keep polling
                console.warn(`[PipingMeter] Status check error: ${statusResult.error}. Retrying...`);
            } else {
                const { status, statusLabel } = statusResult;
                console.log(`[PipingMeter] Order ${orderId} status: ${status} (${statusLabel})`);

                if (status === 2) {
                    return { success: true };          // ✅ Recharge confirmed
                }

                if (status === 3) {
                    return { success: false, error: 'Recharge failed on the meter provider side (status: failed).' };
                }

                // status 0 (waiting) or 1 (processing) → keep polling
            }

            await this.sleep(POLL_INTERVAL_MS);
        }

        // Timed out — the order may still complete asynchronously.
        // We return success=false so the controller can mark it as PENDING.
        console.warn(`[PipingMeter] Order ${orderId} status polling timed out after ${POLL_TIMEOUT_MS}ms.`);
        return {
            success: false,
            error: `Order ${orderId} is still processing. Check status later (timed out after ${POLL_TIMEOUT_MS / 1000}s).`,
        };
    }

    /**
     * Calculate approximate gas units for a given RWF amount.
     * Piping gas is measured in m³. Rate: ~850 RWF per m³ (configurable).
     */
    private calculateUnits(amountRwf: number): number {
        const ratePerM3 = Number(process.env.LORAWAN_RATE_PER_M3) || 850;
        return parseFloat((amountRwf / ratePerM3).toFixed(4));
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

export default new PipingMeterService();
