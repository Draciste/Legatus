function Get-OpenAiQuotaCategory($Code, $Type, $HttpStatus) {
    $billingCodes = 'insufficient_quota','credit_balance_exhausted','billing_hard_limit_reached',
        'organization_spend_limit_exceeded','organization_usage_limit_exceeded'
    if ($Code -cin $billingCodes -or $Type -cin $billingCodes) { return 'billing' }
    if ($Code -ceq 'rate_limit_exceeded' -or $Type -cin 'rate_limit_exceeded','rate_limit_error') { return 'capacity' }
    if ($HttpStatus -eq 429) { return 'unclassified_429' }
}
