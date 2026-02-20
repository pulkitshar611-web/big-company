import axios from 'axios';

export interface ZhongyiMeterRechargeParams {
    meterNumber: string;
    amount: number;
    customerRef: string;
}

export interface ZhongyiMeterRechargeResult {
    success: boolean;
    token?: string;
    meterNumber: string;
    amount: number;
    units: number;
    apiReference: string;
    message: string;
    raw?: any;
    error?: string;
}

class ZhongyiMeterService {
    private apiBaseUrl: string;
    private companyCode: string;
    private apiKey: string;

    constructor() {
        this.apiBaseUrl = process.env.ZHONGYI_API_BASE_URL || 'http://api.zhongyi-gas.com';
        this.companyCode = process.env.ZHONGYI_COMPANY_CODE || '';
        this.apiKey = process.env.ZHONGYI_API_KEY || '';
    }

    /**
     * Validate the meter number with Zhongyi API.
     */
    async validateMeter(meterNumber: string): Promise<{ success: boolean; error?: string; raw?: any }> {
        // Placeholder for Zhongyi-specific validation logic
        console.log(`[ZhongyiMeter] Validating meter: ${meterNumber}`);
        return { success: true };
    }

    /**
     * Recharge a Zhongyi gas meter (usually generates a token or direct credit).
     */
    async rechargeMeter(params: ZhongyiMeterRechargeParams): Promise<ZhongyiMeterRechargeResult> {
        console.log(`[ZhongyiMeter] Recharging meter ${params.meterNumber} with ${params.amount} RWF`);

        try {
            // STEP 1: Validate
            const validation = await this.validateMeter(params.meterNumber);
            if (!validation.success) {
                return {
                    success: false,
                    meterNumber: params.meterNumber,
                    amount: params.amount,
                    units: 0,
                    apiReference: '',
                    message: validation.error || 'Meter validation failed',
                    error: validation.error
                };
            }

            // STEP 2: Placeholder for actual API call
            // Simulated success for now
            const units = this.calculateUnits(params.amount);

            return {
                success: true,
                meterNumber: params.meterNumber,
                amount: params.amount,
                units: units,
                token: 'ZHONGYI-' + Math.random().toString(36).substring(2, 10).toUpperCase(),
                apiReference: `ZY-${Date.now()}`,
                message: 'Zhongyi meter recharged successfully (Simulated)',
            };

        } catch (error: any) {
            console.error('[ZhongyiMeter] API Error:', error.message);
            return {
                success: false,
                meterNumber: params.meterNumber,
                amount: params.amount,
                units: 0,
                apiReference: '',
                message: 'Failed to connect to Zhongyi API',
                error: error.message
            };
        }
    }

    private calculateUnits(amountRwf: number): number {
        // Assume standard rate or fetch from config
        return parseFloat((amountRwf / 1500).toFixed(4));
    }
}

export default new ZhongyiMeterService();
