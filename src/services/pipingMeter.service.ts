import axios from 'axios';

/**
 * Piping Gas Meter Service
 * 
 * Handles integration with Direct Piping Gas Meters.
 * API Swagger reference: http://www.server-newv.stronpower.com/swagger/ui/index
 * 
 * Unlike Token Meters, piping meters are recharged directly:
 * the API sends the credit to the meter's controller via the network.
 * No physical token is needed — the meter auto-updates.
 * 
 * Flow:
 *  1. Customer pays → calls rechargePipingMeter()
 *  2. System calls Stronpower API
 *  3. API directly credits the meter unit
 *  4. API returns confirmation with reference number
 */

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
    apiReference?: string;   // External transaction reference from Stronpower
    message?: string;
    error?: string;
}

class PipingMeterService {
    private apiBaseUrl: string;
    private apiKey: string;
    private apiSecret: string;
    private companyCode: string;

    constructor() {
        // Stronpower API base URL (from swagger docs: http://www.server-newv.stronpower.com)
        this.apiBaseUrl = process.env.PIPING_METER_API_URL || 'http://www.server-newv.stronpower.com/api';
        this.apiKey = process.env.PIPING_METER_API_KEY || '';
        this.apiSecret = process.env.PIPING_METER_API_SECRET || '';
        this.companyCode = process.env.PIPING_METER_COMPANY_CODE || '';
    }

    /**
     * Main public method: recharge a piping gas meter directly.
     * Makes API call to Stronpower system which directly credits the meter.
     */
    async rechargePipingMeter(params: PipingMeterRechargeParams): Promise<PipingMeterRechargeResult> {
        const isDev = process.env.DEV_MODE === 'true' || process.env.DEV_MODE === '1';

        if (isDev) {
            console.log(`🛠️ [PipingMeter DEV MODE] Simulating recharge for meter: ${params.meterNumber}, Amount: ${params.amount}`);
            const units = this.calculateUnits(params.amount);
            return {
                success: true,
                meterNumber: params.meterNumber,
                amount: params.amount,
                units,
                apiReference: `DEV-PIPE-${Date.now()}`,
                message: `Piping meter recharged successfully with ${units} m³ (DEV_MODE)`,
            };
        }

        try {
            // Stronpower API recharge endpoint (based on swagger documentation)
            const requestBody = {
                meter_no: params.meterNumber,
                recharge_amount: params.amount,
                currency: 'RWF',
                company_code: this.companyCode,
                order_no: params.customerRef,
                customer_phone: params.customerPhone || '',
            };

            const requestHeaders = {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
                'X-Api-Key': this.apiKey,
                'X-Api-Secret': this.apiSecret,
            };

            console.log(`🚀 [PipingMeter] Recharging meter ${params.meterNumber}, Amount: ${params.amount}`);
            console.log('[PipingMeter] Request body:', JSON.stringify(requestBody, null, 2));

            const response = await axios.post(
                `${this.apiBaseUrl}/recharge/meter`,
                requestBody,
                {
                    headers: requestHeaders,
                    timeout: 20000,
                    validateStatus: (status) => status < 500,
                }
            );

            console.log(`[PipingMeter] Response status: ${response.status}`);
            console.log('[PipingMeter] Response data:', JSON.stringify(response.data, null, 2));

            if (response.status >= 400) {
                return {
                    success: false,
                    error: response.data?.message || response.data?.error || `API error: HTTP ${response.status}`,
                };
            }

            // Parse success from response - Stronpower API may use different success indicators
            const isSuccess =
                response.data?.success === true ||
                response.data?.status === 'SUCCESS' ||
                response.data?.code === 0 ||
                response.data?.result_code === '00' ||
                response.data?.data?.status === 'SUCCESS';

            if (!isSuccess) {
                return {
                    success: false,
                    error: response.data?.message || response.data?.error || 'Piping meter recharge was rejected by API',
                };
            }

            const units = response.data?.units || response.data?.data?.units || this.calculateUnits(params.amount);
            const apiRef =
                response.data?.reference ||
                response.data?.transaction_id ||
                response.data?.data?.order_no ||
                response.data?.order_no;

            return {
                success: true,
                meterNumber: params.meterNumber,
                amount: params.amount,
                units,
                apiReference: String(apiRef || params.customerRef),
                message: response.data?.message || 'Piping meter recharged successfully',
            };
        } catch (error: any) {
            console.error('[PipingMeter] API Error:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.message || error.message || 'Failed to connect to Piping Meter API',
            };
        }
    }

    /**
     * Calculate approximate gas units for a given RWF amount.
     * Piping gas is measured in m³. Rate: ~850 RWF per m³ (from system config).
     */
    private calculateUnits(amountRwf: number): number {
        return parseFloat((amountRwf / 850).toFixed(4));
    }
}

export default new PipingMeterService();
